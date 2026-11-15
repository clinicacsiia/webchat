// FLUXOGRAMA: entrada (o minha-vez/index.html REAL e a página /acesso/ REAL num Chromium de celular; Supabase simulado por interceptação de rede com o PIN obrigatório ligado e desligado) -> validação (sem aparelho, com sessão antiga de e-mail e senha, com link da fila emitido pela clínica, com aparelho, com recusa do servidor, com laço) -> lógica (com o PIN obrigatório não há check-in sem cadastro nem entrada por e-mail e senha: vai à porta; aparelho entra sozinho e manda o cabeçalho x-acesso; link da fila só mostra a fila; a porta que não termina mostra aviso e NUNCA abre) -> saída (casos PASS/FAIL)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (auditoria de 15/11/2026: a minha-vez tinha check-in sem PIN e login por e-mail e senha).
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

await caso('PIN obrigatório, SEM aparelho e sem link da clínica: nada de check-in sem cadastro; vai para a porta do PIN (/acesso/?voltar=acompanhar)', async () => {
  const { page, ctx, reg } = await abrir({});
  await page.waitForURL(/\/acesso\//, { timeout: 8000 }).catch(() => {}); await espera(400);
  const url = page.url(), t = await texto(page); await ctx.close();
  return { ok: /\/acesso\/\?voltar=acompanhar/.test(url) && !/Fazer check-in/.test(t) && !reg.rpcs.includes('checkin_publico') && !reg.erros.length, detalhe: `${url} erros=${reg.erros[0] || '-'}` };
});
await caso('PIN obrigatório com sessão ANTIGA de e-mail e senha e sem aparelho: NÃO entra pela conta antiga (nem consulta o resumo da conta); vai à porta, que leva ao PIN', async () => {
  const { page, ctx, reg } = await abrir({ sessaoAntiga: true });
  await page.waitForURL(/\/acesso\//, { timeout: 8000 }).catch(() => {}); await espera(400);
  const url = page.url(); await ctx.close();
  return { ok: /\/acesso\/\?voltar=acompanhar/.test(url) && !reg.rpcs.includes('conta_paciente_resumo') && !reg.rpcs.includes('fila_minha_vez'), detalhe: `${url} rpcs=${reg.rpcs.join(',')}` };
});
await caso('PIN obrigatório com aparelho: entra sozinho (celular + PIN), mostra o check-in de um toque e manda o código do aparelho em TODA chamada', async () => {
  const { page, ctx, reg } = await abrir({ dev: true });
  await page.waitForSelector('#btnCheckinApp', { timeout: 8000 });
  const t = await texto(page), semAparelho = reg.cab.filter((x) => x.nome !== 'app_porta' && x.x !== DEV).map((x) => x.nome);
  await ctx.close();
  return { ok: /Olá, Ana/.test(t) && !/e-mail e senha/i.test(t) && semAparelho.length === 0 && !reg.erros.length, detalhe: `semAparelho=${semAparelho.join(',') || '-'}` };
});
await caso('PIN obrigatório com o link da fila que a clínica emitiu (ticket): mostra só a fila, sem pedir e-mail e senha', async () => {
  const { page, ctx, reg } = await abrir({ ticket: true });
  await page.waitForSelector('text=/posi|frente|sua vez|aguard/i', { timeout: 8000 }).catch(() => {}); await espera(500);
  const t = await texto(page), url = page.url(); await ctx.close();
  return { ok: !/\/acesso\//.test(url) && !/Entrar com e-mail/i.test(t) && reg.rpcs.includes('fila_minha_vez_ticket'), detalhe: `${url} ${t.slice(0, 80)}` };
});
await caso('PIN obrigatório e a recepção criou conta com senha provisória (ticket com conta_pronta): em vez da senha provisória, convida a criar o PIN', async () => {
  const { page, ctx } = await abrir({ ticket: true, ticketResp: { situacao: 'aguardando', senha: 7, posicao: 3, a_frente: 2, total: 9, conta_pronta: true, email: 'antigo@exemplo.invalid' } });
  await page.waitForSelector('#criarPin', { timeout: 8000 }).catch(() => {});
  const t = await texto(page), href = await page.locator('#criarPin').getAttribute('href').catch(() => null); await ctx.close();
  return { ok: /Crie o seu acesso rápido/.test(t) && !/senha provisória/i.test(t) && /\/acesso\/\?voltar=acompanhar$/.test(href || ''), detalhe: `${href} ${t.slice(0, 60)}` };
});
await caso('o servidor recusa com "pin_obrigatorio" (PIN vencido ou aparelho desconhecido): a minha-vez volta à porta do PIN', async () => {
  const { page, ctx } = await abrir({ dev: true, recusar: true });
  await page.waitForURL(/\/acesso\//, { timeout: 8000 }).catch(() => {});
  const url = page.url(); await ctx.close();
  return { ok: /\/acesso\/\?voltar=acompanhar/.test(url), detalhe: url };
});
await caso('trava contra laço: depois de 3 voltas NÃO abre o check-in: mostra "Não conseguimos abrir o seu acesso" com Tentar de novo', async () => {
  const { page, ctx } = await abrir({ tent: { n: 3, t: Date.now() } });
  await page.waitForSelector('#portaTentar', { timeout: 8000 }).catch(() => {});
  const t = await texto(page), href = await page.locator('#portaTentar').getAttribute('href').catch(() => null); await ctx.close();
  return { ok: /Não conseguimos abrir o seu acesso/.test(t) && !/Fazer check-in/.test(t) && /\/acesso\/\?voltar=acompanhar$/.test(href || ''), detalhe: `${href}` };
});
await caso('a pergunta app_porta falha e o PIN era obrigatório neste aparelho: continua exigindo (vai à porta); sem esse histórico, abre como antes', async () => {
  const a = await abrir({ portaFalha: true, init: [['csi_porta_v1', '1']] });
  await a.page.waitForURL(/\/acesso\//, { timeout: 8000 }).catch(() => {}); const foi = /\/acesso\//.test(a.page.url()); await a.ctx.close();
  const b = await abrir({ portaFalha: true });
  await b.page.waitForSelector('#btnCheckin', { timeout: 8000 }).catch(() => {}); const abriu = await b.page.locator('#btnCheckin').count(); await b.ctx.close();
  return { ok: foi && abriu === 1, detalhe: `lembrava=${foi} semHistorico=${abriu}` };
});
await caso('PIN obrigatório DESLIGADO: a minha-vez segue como sempre (check-in e entrada por e-mail disponíveis)', async () => {
  const { page, ctx } = await abrir({ obrig: false });
  await page.waitForSelector('#btnCheckin', { timeout: 8000 }).catch(() => {});
  const t = await texto(page), url = page.url(); await ctx.close();
  return { ok: !/\/acesso\//.test(url) && /Fazer check-in/.test(t) && /Entrar com e-mail/i.test(t), detalhe: `${url}` };
});

await browser.close(); srv.close();
const falhas = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} passaram.`);
process.exit(falhas ? 1 : 0);
