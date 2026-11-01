// FLUXOGRAMA: entrada (portal /minha-vez/ servido localmente + Supabase simulado por interceptação de rede) -> validação (sem permissão de notificação o portal trava no passo 1; sem login trava no passo 2) -> lógica (entrar, "Cheguei", posição, "perto" e "sua vez" com aviso local, sair remove o aparelho) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
// Requer um Chromium (CHROMIUM_PATH ou o do Playwright). Não fala com o Supabase real: o banco está em sql-chegada.test.mjs.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { chromium } from 'playwright';
import { REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, d = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, 'exceção: ' + e.message.split('\n')[0]); } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const TIPOS = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/json', '.png': 'image/png' };
const srv = http.createServer((req, res) => {
  const f = resolve(REPO, '.' + new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html'));
  if (!f.startsWith(REPO) || !existsSync(f)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TIPOS[extname(f)] || 'application/octet-stream' }).end(readFileSync(f));
});
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const lib = readFileSync(resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'), 'utf8');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: ID, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.x`;
const usuario = { id: ID, aud: 'authenticated', role: 'authenticated', email: 'ana@teste.local', email_confirmed_at: '2026-11-01T10:00:00Z', app_metadata: {}, user_metadata: {}, created_at: '2026-11-01T10:00:00Z' };
const sessao = { access_token: TOKEN, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'r', user: usuario };

async function abrir({ permissao = true, logado = false } = {}) {
  const ctx = await browser.newContext({ permissions: permissao ? ['notifications'] : [] });
  const estado = { fila: { situacao: 'fora', total: 2, pode_chegar: true }, rpcs: [], avisos: [] };
  await ctx.route('**/cdn.jsdelivr.net/**', (r) => r.fulfill({ contentType: 'text/javascript', body: lib }));
  await ctx.route('**/*.supabase.co/**', async (r) => {
    const u = new URL(r.request().url()), j = (body, status = 200) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (u.pathname === '/auth/v1/token') { const c = JSON.parse(r.request().postData() || '{}'); return c.password === 'certa' ? j(sessao) : j({ code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials', message: 'Invalid login credentials' }, 400); }
    if (u.pathname === '/auth/v1/logout') return r.fulfill({ status: 204 });
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const nome = u.pathname.split('/').pop(); estado.rpcs.push(nome);
      if (nome === 'conta_paciente_resumo') return j({ conta: true, email: usuario.email });
      if (nome === 'fila_minha_vez') return j(estado.fila);
      if (nome === 'fila_cheguei') { estado.fila = { situacao: 'aguardando', senha: 3, posicao: 3, a_frente: 2, total: 3 }; return j(estado.fila); }
      if (nome === 'fila_config_publica') return j({ vapid: '' });
      return j(null);
    }
    return j({});
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__avisos = [];
    const orig = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (t, o) { window.__avisos.push(t); return Promise.resolve(); };
  });
  if (logado) await page.addInitScript((s) => localStorage.setItem('csi-paciente-auth', s), JSON.stringify(sessao));
  await page.goto(`${base}/minha-vez/`);
  return { page, ctx, estado };
}
const texto = (p) => p.locator('#raiz').innerText();

await caso('sem permissão de aviso: pede para permitir e não mostra login', async () => {
  const { page, ctx } = await abrir({ permissao: false });
  await page.waitForSelector('#btnPerm, .erro, h1'); const t = await texto(page); await ctx.close();
  return { ok: /Ative os avisos/.test(t) && !/Entre na sua conta/.test(t), detalhe: t.slice(0, 60) };
});
await caso('com permissão e sem login: mostra o login', async () => {
  const { page, ctx } = await abrir(); await page.waitForSelector('#e'); const ok = /Entre na sua conta/.test(await texto(page)); await ctx.close(); return { ok };
});
await caso('senha errada mostra erro em português', async () => {
  const { page, ctx } = await abrir(); await page.fill('#e', 'ana@teste.local'); await page.fill('#s', 'errada'); await page.click('button[type=submit]');
  await page.waitForFunction(() => /incorretos/.test(document.body.innerText)); await ctx.close(); return { ok: true };
});
await caso('entra, vê "Chegou na clínica?" e toca Cheguei → 3º da fila, 2 à frente', async () => {
  const { page, ctx, estado } = await abrir(); await page.fill('#e', 'ana@teste.local'); await page.fill('#s', 'certa'); await page.click('button[type=submit]');
  await page.waitForFunction(() => /Chegou na clínica/.test(document.body.innerText));
  await page.click('text=Cheguei');
  await page.waitForFunction(() => /3º/.test(document.body.innerText));
  const t = await texto(page); await ctx.close();
  return { ok: /Faltam 2 pessoas/.test(t) && estado.rpcs.includes('fila_cheguei'), detalhe: t.replace(/\n+/g, ' | ') };
});
await caso('sessão guardada abre direto no portal; quando chamam, mostra "É a sua vez" e avisa', async () => {
  const { page, ctx, estado } = await abrir({ logado: true }); await page.waitForFunction(() => /Chegou na clínica/.test(document.body.innerText));
  estado.fila = { situacao: 'aguardando', senha: 3, posicao: 2, a_frente: 1, total: 3 };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => /2º/.test(document.body.innerText), null, { timeout: 5000 });
  estado.fila = { situacao: 'chamado', senha: 3, total: 2 };
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForFunction(() => /É a sua vez/.test(document.body.innerText), null, { timeout: 5000 });
  const av = await page.evaluate(() => window.__avisos); await ctx.close();
  return { ok: av.includes('Está perto da sua vez') || av.includes('É a sua vez!'), detalhe: JSON.stringify(av) };
});
await caso('Sair volta ao login', async () => {
  const { page, ctx } = await abrir({ logado: true }); await page.waitForSelector('#btnSair:not([hidden])'); await page.click('#btnSair');
  await page.waitForSelector('#e'); await ctx.close(); return { ok: true };
});

await browser.close(); srv.close();
const falhas = resultados.filter((x) => !x).length;
console.log(falhas ? `\n${falhas} FALHA(S)` : `\nTodos os ${resultados.length} casos passaram.`);
process.exit(falhas ? 1 : 0);
