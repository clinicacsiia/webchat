// FLUXOGRAMA: entrada (o minha-vez/index.html REAL num Chromium de celular; Supabase simulado por interceptação de rede; aparelho com PIN + link da fila) -> validação (exames de hoje com número de marcação; cancelado, de outro dia e sem número não contam) -> lógica (no lugar de "Nº lugar na fila" a tela mostra "Você está na clínica" com a etapa e o número da marcação de cada exame de hoje; sem exame de hoje continua o lugar; "É a sua vez" não muda) -> saída (PASS/FAIL por caso; sai com erro se algum falhar)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (check-in do Klingo e etapas na tela Minha vez).
// Dados inventados. Nada fala com o Supabase de verdade. Requer Chromium (CHROMIUM_PATH ou o do Playwright).
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const RAIZ = resolve(import.meta.dirname, '..');
const LIB = readFileSync(resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'));
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const DEV = 'dispositivo-de-teste', TICKET = '44444444-4444-4444-8444-444444444444';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await new Promise((ok) => {
  const s = http.createServer((req, res) => {
    let p = join(RAIZ, normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, ''));
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
    if (!existsSync(p)) { res.writeHead(404); res.end('x'); return; }
    res.writeHead(200, { 'content-type': TIPOS[extname(p)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(readFileSync(p));
  }).listen(0, '127.0.0.1', () => ok(s));
});
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + e.message.split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };

const DADOS = { ok: true, nome: 'Ana Souza Teste', telefone_final: '0001', email_salvo: true, pessoas: [{ nome: 'Ana Souza Teste', eu: true }], pedidos: [], novidades: 0, resultados: [] };
async function abrir({ obrig = true, dev = false, ticket = false, ticketResp = null, sessaoAntiga = false, recusar = false, tent = null, portaFalha = false, init = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 } });   // com service worker: a minha-vez espera o registro dele (sw.js só recebe avisos)
  await ctx.addInitScript(([d, t, so, tn, ini]) => {
    try {
      if (d) localStorage.setItem('csi_acesso_v2', JSON.stringify({ dev: d, nome1: 'Ana' }));
      if (t) localStorage.setItem('csi-checkin-ticket', t);
      if (so) localStorage.setItem('csi-paciente-auth', JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, user: { id: '33333333-3333-4333-8333-333333333333', aud: 'authenticated', role: 'authenticated', email: 'antigo@exemplo.invalid', app_metadata: {}, user_metadata: {} } }));
      if (tn) sessionStorage.setItem('csi_mv_tent', JSON.stringify(tn));
      for (const [k, v] of ini) localStorage.setItem(k, v);
    } catch { /* sem armazenamento */ }
  }, [dev ? DEV : null, ticket ? TICKET : null, sessaoAntiga, tent, init]);
  const reg = { rpcs: [], cab: [], erros: [] };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => reg.erros.push(e.message));
  await ctx.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: LIB }));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)(?!.*supabase\.co)(?!.*cdn\.jsdelivr)/, (r) => r.abort());
  await ctx.route('**/*.supabase.co/**', async (r) => {
    const rq = r.request(), u = new URL(rq.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const j = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    if (rq.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (!u.pathname.startsWith('/rest/v1/rpc/')) return j(u.pathname.startsWith('/rest/v1/') ? [] : {});
    const nome = u.pathname.split('/').pop(); reg.rpcs.push(nome); reg.cab.push({ nome, x: rq.headers()['x-acesso'] || null });
    if (recusar && nome === 'app_pedidos') return j({ code: 'P0001', message: 'pin_obrigatorio', hint: 'Digite o seu PIN para continuar.' }, 400);
    switch (nome) {
      case 'app_porta': return portaFalha ? j({ message: 'erro' }, 500) : j({ ativo: true, obrigatorio: obrig, local: false });
      case 'app_ativo': return j(true);
      case 'app_pedidos': return j(DADOS);
      case 'app_perfil': return j({ ok: true, perfil: { nome: 'Ana Souza Teste', email: 'ana@exemplo.invalid', telefone: '71991230001' } });
      case 'app_pendencias': return j({ ok: true, pendencias: [] });
      case 'fila_minha_vez_ticket': return j(ticketResp || { situacao: 'aguardando', senha: 7, posicao: 3, a_frente: 2, total: 9 });
      case 'conta_paciente_resumo': return j({ conta: true, email: 'antigo@exemplo.invalid', nome: 'Antigo Teste', telefone: '71991230099' });
      case 'fila_config_publica': return j({ aviso_antes: 2 });
      default: return j({});
    }
  });
  await page.goto(`${base}/minha-vez/`);
  return { page, ctx, reg };
}
const texto = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

const hoje = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const amanha = new Date(Date.parse(hoje + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
const ex = (o) => ({ id: 1, nome: 'RM JOELHO', unidade: 'Centro', data: hoje, hora: '08:00', ok: 3, excecao: null, voucher: '9101', chegada: null, resultado: null, ...o });
const pedido = (exames, o = {}) => ({ conversa: 'c1', token: 't', pessoa: 'Ana Souza Teste', eu: true, aberta: true, status: 'em_atendimento', tipo: 'proprio', exames, sig: 's', novo: false, pode_apagar: false, pode_reabrir: false, pode_avaliar: false, ...o });
const abrirFila = async (pedidos, fila = null) => {
  Object.assign(DADOS, { pedidos });
  const r = await abrir({ dev: true, ticket: true, ticketResp: fila });
  await r.page.waitForFunction(() => /Você está|É a sua vez|Chegou na clínica/.test(document.body.innerText), null, { timeout: 8000 });
  await espera(300);
  return r;
};

await caso('exames de hoje: mostra "Você está na clínica", a etapa e o número da marcação de cada um, e NÃO mostra o lugar na fila', async () => {
  const { page, ctx, reg } = await abrirFila([pedido([ex({ id: 1, ok: 4, chegada: '07:50', voucher: '9101' }), ex({ id: 2, ok: 3, voucher: '9102', hora: '09:00' }), ex({ id: 3, ok: 5, voucher: '9104', hora: '10:00', chegada: '07:50' })])]);
  const t = await texto(page); const cartoes = await page.locator('.cartao.hoje').count(); await ctx.close();
  return { ok: cartoes === 1 && /Você está na clínica/.test(t) && /Sua senha: 7/.test(t) && /Marcação nº 9101/.test(t) && /Chegada registrada às 07:50/.test(t) && /Marcação nº 9102/.test(t) && /Aguardando a recepção/.test(t) && /Marcação nº 9104/.test(t) && /Em atendimento/.test(t)
    && !/Você está na fila/.test(t) && !/\blugar\b/.test(t) && !/3º/.test(t) && reg.erros.length === 0, detalhe: t.slice(0, 260) + ' | erros: ' + reg.erros.join(';') };
});
await caso('sem exame de hoje (só amanhã): continua o lugar na fila', async () => {
  const { page, ctx } = await abrirFila([pedido([ex({ data: amanha, voucher: '9200' })])]);
  const t = await texto(page); const cartoes = await page.locator('.cartao.hoje').count(); await ctx.close();
  return { ok: /Você está na fila/.test(t) && /3º/.test(t) && cartoes === 0, detalhe: t.slice(0, 160) };
});
await caso('exame de hoje cancelado ou sem número de marcação não conta: continua o lugar na fila', async () => {
  const { page, ctx } = await abrirFila([pedido([ex({ excecao: 'cancelado', ok: null }), ex({ id: 5, voucher: null })])]);
  const t = await texto(page); const cartoes = await page.locator('.cartao.hoje').count(); await ctx.close();
  return { ok: /Você está na fila/.test(t) && cartoes === 0, detalhe: t.slice(0, 160) };
});
await caso('quando a recepção chama, continua "É a sua vez!" (a chamada não muda)', async () => {
  const { page, ctx } = await abrirFila([pedido([ex({ ok: 4, chegada: '07:50' })])], { situacao: 'chamado', senha: 7, total: 4 });
  const t = await texto(page); const cartoes = await page.locator('.cartao.hoje').count(); await ctx.close();
  return { ok: /É a sua vez/.test(t) && cartoes === 0, detalhe: t.slice(0, 120) };
});
await caso('família: o exame de cada pessoa aparece com o nome de quem é (Você: / Leo:)', async () => {
  const { page, ctx } = await abrirFila([pedido([ex({ id: 1, voucher: '9101', ok: 4, chegada: '07:50' })]), pedido([ex({ id: 2, voucher: '9301', ok: 3, nome: 'US ABDOME' })], { conversa: 'c2', pessoa: 'Leo Souza Teste', eu: false })]);
  const t = await texto(page); await ctx.close();
  return { ok: /Você: /.test(t) && /Leo: /.test(t) && /Marcação nº 9301/.test(t), detalhe: t.slice(0, 200) };
});
await caso('"Acompanhe seus pedidos" mostra o número da marcação e a hora da chegada em cada exame', async () => {
  const { page, ctx } = await abrirFila([pedido([ex({ ok: 4, chegada: '07:50', voucher: '9101' })])]);
  const dentro = await page.locator('.cartao.pedido').first().innerText(); await ctx.close();
  return { ok: /Marcação nº 9101/.test(dentro) && /chegada às 07:50/.test(dentro), detalhe: dentro.replace(/\s+/g, ' ').slice(0, 200) };
});
await caso('exame sem número de marcação (pedido do chat) não mostra "Marcação nº"', async () => {
  const { page, ctx } = await abrirFila([pedido([ex({ ok: 1, voucher: null, data: null, hora: null })])]);
  const t = await texto(page); await ctx.close();
  return { ok: !/Marcação nº/.test(t), detalhe: t.slice(0, 120) };
});

await browser.close(); srv.close();
const falhas = resultados.filter((x) => !x).length;
console.log(falhas ? `\n${falhas} FALHA(S)` : `\nTodos os ${resultados.length} casos passaram.`);
process.exit(falhas ? 1 : 0);
