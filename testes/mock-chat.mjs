// FLUXOGRAMA: entrada (repositório servido localmente + Supabase simulado com estado) -> validação (cada chamada do chat é registrada e pode ser atrasada ou falhar) -> lógica (um "mundo" guarda a conversa: mensagens, o que a listagem esconde, atrasos e erros) -> saída (página do chat pronta e conferida por quem importa este módulo)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
//
// Servidor de mentira do chat para os testes de navegador da Fase 9 (corrida das mensagens e Sentinela).
// Não fala com o Supabase real: simula só o que o chat do paciente chama. O objetivo é controlar o TEMPO
// (resposta que chega antes da mensagem do paciente, chamada que demora, chamada que falha).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
export const { chromium } = require('playwright');

export const RAIZ = resolve(import.meta.dirname, '..');
const UMD = resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const HOST = 'nrvuynjwcgwpjdptkiay.supabase.co';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function servidor() {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      const caminho = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let arquivo = join(RAIZ, caminho);
      if (existsSync(arquivo) && !extname(arquivo)) arquivo = join(arquivo, 'index.html');
      if (!existsSync(arquivo)) { res.writeHead(404); res.end('não encontrado'); return; }
      res.writeHead(200, { 'content-type': TIPOS[extname(arquivo)] ?? 'application/octet-stream' });
      res.end(await readFile(arquivo));
    }).listen(0, '127.0.0.1', () => ok(s));
  });
}

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

export const CONFIG_CORPO = {
  modalidades: [
    { codigo: 'RM', nome: 'Ressonância', total: 40, mapa: true, regioes: ['cranio', 'ombro', 'torax', 'coluna_lombar', 'joelho'] },
    { codigo: 'US', nome: 'Ultrassom', total: 60, mapa: true, regioes: ['abdome', 'joelho'] },
    { codigo: 'MAMO', nome: 'Mamografia', total: 5, mapa: false, regioes: [] },
  ],
  regioes: [
    { codigo: 'cranio', nome: 'Crânio', tem_lado: false }, { codigo: 'ombro', nome: 'Ombro', tem_lado: true },
    { codigo: 'torax', nome: 'Tórax', tem_lado: false }, { codigo: 'coluna_lombar', nome: 'Coluna lombar', tem_lado: false },
    { codigo: 'joelho', nome: 'Joelho', tem_lado: true }, { codigo: 'abdome', nome: 'Abdome', tem_lado: false },
  ],
};

// O estado da conversa de mentira e as regras de cada chamada.
export function criarMundo(opcoes = {}) {
  const m = {
    msgs: [], prox: 100, conversa: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', token: 'token-de-teste', status: 'aguardando', motor: true, passo: null,
    escondeCliente: false,        // a listagem esconde a mensagem do paciente enquanto a chamada dele não volta (o aviso em tempo real chegou antes)
    ocultos: new Set(), atraso: { chat_responder: 0, chat_enviar: 0, chat_listar: 0 }, falhas: {}, chamadas: [], incidentes: [],
    ...opcoes,
  };
  const agora = () => new Date().toISOString();
  m.inserir = (autor, texto, opcoes2 = null) => {
    const x = { id: ++m.prox, autor, texto, opcoes: opcoes2, criado_em: agora(), agente: autor === 'agente' ? 'Assistente virtual' : null };
    m.msgs.push(x); if (autor === 'agente' && opcoes2 && opcoes2.passo) m.passo = opcoes2.passo;
    return x;
  };
  m.perguntaMotivo = () => m.inserir('agente', 'O que você precisa?', { tipo: 'escolha', passo: 'motivo',
    itens: [{ valor: 'exame', rotulo: 'Exame', desc: 'Ressonância, tomografia e outros' }, { valor: 'consulta', rotulo: 'Consulta', desc: 'Com médico ou especialista' }] });
  m.perguntaPlano = () => m.inserir('agente', 'O atendimento será particular ou por convênio?', { tipo: 'escolha', passo: 'plano',
    itens: [{ valor: 'particular', rotulo: 'Particular' }, { valor: 'convenio', rotulo: 'Convênio' }] });
  m.perguntaPedido = () => m.inserir('agente', 'Escolha o exame.', { tipo: 'pedido_exames', passo: 'exame', rotulo: 'Escolher exames no mapa do corpo' });
  m.final = () => m.inserir('agente', 'Pronto! Recebemos tudo.', { tipo: 'acompanhar' });
  m.seguinte = () => (m.passo === 'motivo' ? m.perguntaPlano() : m.passo === 'plano' ? m.final() : m.inserir('agente', 'Certo.', null));
  m.lista = (apos) => m.msgs.filter((x) => x.id > apos && !m.ocultos.has(x.id));

  m.tratar = async (nome, corpo) => {
    m.chamadas.push({ nome, corpo, t: Date.now() });
    if (m.atraso[nome]) await espera(m.atraso[nome]);
    const falha = m.falhas[nome];
    if (falha && (falha.vezes == null || falha.vezes > 0)) { if (falha.vezes != null) falha.vezes--; return { status: falha.status ?? 400, body: falha.corpo ?? { code: 'XX000', message: 'falha simulada' } }; }
    switch (nome) {
      case 'chat_config': return { body: { nome_empresa: 'Clínica de Teste', boas_vindas: 'Olá!' } };
      case 'chat_iniciar': { m.msgs.length = 0; const q = m.perguntaMotivo(); return { body: { conversa_id: m.conversa, token: m.token, motor: 'fluxo', respostas: [q] } }; }
      case 'chat_listar': return { body: { status: m.status, agente: null, motor_ativo: m.motor, passo: m.passo, mensagens: m.lista(corpo.p_apos || 0) } };
      case 'chat_responder': case 'chat_enviar': {
        const atendente = corpo.p_valor && corpo.p_valor.acao === 'atendente';
        const texto = atendente ? 'Quero falar com um atendente.' : (corpo.p_texto || 'Enviado.');
        const cli = m.inserir('cliente', texto);
        let resp;
        if (atendente) { m.motor = false; resp = m.inserir('agente', 'Um atendente vai continuar com você em instantes.', null); }
        else if (nome === 'chat_enviar') resp = m.inserir('agente', 'Recebemos a sua mensagem.', null);
        else resp = m.seguinte();
        if (m.escondeCliente) m.ocultos.add(cli.id);
        const respostas = [cli, resp];
        if (m.atrasoDepois) await espera(m.atrasoDepois);
        m.ocultos.clear();
        return { body: { id: cli.id, respostas } };
      }
      case 'chat_acompanhar': return { body: { agora: agora(), conversa: m.status, agente: null, equipe_online: true, pedido: 'pronto', tipo: 'exame', conferencia: null, enviado_em: agora(), confirmado: false, horarios: [] } };
      case 'chat_corpo': return { body: CONFIG_CORPO };
      case 'chat_incidente': m.incidentes.push(corpo); return { body: { ok: true } };
      default: return { body: {} };
    }
  };
  return m;
}

export async function novaPaginaChat(browser, mundo, { init = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });
  for (const [fn, arg] of init) await ctx.addInitScript(fn, arg);
  const erros = { excecoes: [] };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => erros.excecoes.push(e.message));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    const nome = (/\/rest\/v1\/rpc\/([a-z0-9_]+)/.exec(url.pathname) || [])[1];
    if (!nome) return rota.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: '[]' });
    let corpo = {}; try { corpo = JSON.parse(req.postData() || '{}'); } catch { /* sem corpo */ }
    const r = await mundo.tratar(nome, corpo);
    return rota.fulfill({ status: r.status ?? 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  if (typeof page.routeWebSocket === 'function') await page.routeWebSocket(/supabase\.co/, (ws) => ws.close());
  return { page, ctx, erros };
}

// Preenche o formulário inicial como um paciente adulto e começa a conversa.
export async function comecarConversa(page, base) {
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('#formInicio', { state: 'visible', timeout: 8000 });
  await page.click('#fQuem .unidade >> nth=0');
  await page.fill('#fNome', 'Maria da Silva');
  await page.fill('#fTel', '71999998888');
  await page.fill('#fEmail', 'maria@teste.local');
  await page.check('#fAceite');
  await page.click('#btnIniciar');
  await page.waitForSelector('#msgs .msg.agente .op', { timeout: 8000 });
}

// A conversa como o paciente a vê: [['A'|'C'|'S', texto]...] na ordem da tela.
export const ordemNaTela = (page) => page.$$eval('#msgs .msg', (ns) => ns.map((n) => [
  n.classList.contains('cliente') ? 'C' : n.classList.contains('agente') ? 'A' : 'S',
  (n.querySelector('span:not(.quem):not(.hora)') || n).textContent.trim().slice(0, 40)]));
