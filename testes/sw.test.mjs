// FLUXOGRAMA: entrada (sw.js carregado num contexto isolado, com self, caches e fetch simulados) -> validação (dispara o evento fetch para a página do chat, a fila, o painel e um POST) -> lógica (o service worker só responde pelo cache o que é do chat; /fila/ e /painel/ passam direto para a rede) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
//
// Por que existe: a URL da fila leva o token de assinatura e o cache do chat usa uma chave única ('./'). Se /fila/ entrasse nesse
// cache, o paciente receberia a página do chat no lugar da fila. Duas sessões já editaram o sw.js; este teste impede que a regra suma.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { REPO } from './stubs-supabase.mjs';

const codigo = readFileSync(`${REPO}/sw.js`, 'utf8');
const BASE = 'https://clinicacsiia.github.io';
const ESCOPO = `${BASE}/webchat/`;

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };

function carregar() {
  const ouvintes = {};
  const gravados = [];
  const cache = {
    match: async () => undefined,
    put: async (chave) => { gravados.push(typeof chave === 'string' ? chave : chave.url); },
    addAll: async () => {},
  };
  const contexto = {
    URL, Request, Promise, console,
    location: { origin: BASE },
    self: {
      registration: { scope: ESCOPO },
      clients: { claim: async () => {} },
      skipWaiting: () => {},
      addEventListener: (tipo, fn) => { ouvintes[tipo] = fn; },
    },
    caches: { open: async () => cache, keys: async () => [], delete: async () => true, match: async () => undefined },
    fetch: async () => ({ ok: true, clone() { return this; } }),
  };
  vm.runInNewContext(codigo, contexto);
  return { ouvintes, gravados };
}

// O service worker só lê method, url e mode do pedido; um objeto simples basta (Request do Node não aceita mode 'navigate').
function disparar(ouvintes, pedido) {
  let respondeu = false;
  ouvintes.fetch({ request: pedido, respondWith: () => { respondeu = true; }, waitUntil: () => {} });
  return respondeu;
}

const { ouvintes, gravados } = carregar();
registrar('o service worker registra o evento fetch', typeof ouvintes.fetch === 'function');

const casos = [
  ['página do chat (navegação) é atendida pelo cache', { method: 'GET', url: `${ESCOPO}`, mode: 'navigate' }, true],
  ['link do WhatsApp com ?origem= também', { method: 'GET', url: `${ESCOPO}?origem=whatsapp`, mode: 'navigate' }, true],
  ['/fila/ com token NÃO passa pelo cache', { method: 'GET', url: `${ESCOPO}fila/?token=aaa.bbb.ccc`, mode: 'navigate' }, false],
  ['/fila/ sem token NÃO passa pelo cache', { method: 'GET', url: `${ESCOPO}fila/`, mode: 'navigate' }, false],
  ['arquivos de /fila/ (js e css) NÃO passam pelo cache', { method: 'GET', url: `${ESCOPO}fila/fila.js`, mode: 'cors' }, false],
  ['/painel/ NÃO passa pelo cache', { method: 'GET', url: `${ESCOPO}painel/`, mode: 'navigate' }, false],
  ['POST NÃO passa pelo cache', { method: 'POST', url: `${ESCOPO}`, mode: 'cors' }, false],
  ['outra origem NÃO passa pelo cache', { method: 'GET', url: 'https://nrvuynjwcgwpjdptkiay.supabase.co/rest/v1/rpc/chat_config', mode: 'cors' }, false],
];
for (const [nome, pedido, esperado] of casos) {
  const respondeu = disparar(ouvintes, pedido);
  registrar(nome, respondeu === esperado, `respondeu=${respondeu}, esperado=${esperado}`);
}

// Nada da fila pode ter sido gravado no cache, nem a URL com o token.
await new Promise((ok) => setTimeout(ok, 50));
registrar('nenhuma URL da fila foi gravada no cache', !gravados.some((u) => u.includes('/fila/') || u.includes('token=')), gravados.join(' | '));

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
