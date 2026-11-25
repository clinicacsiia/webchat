// FLUXOGRAMA: entrada (o chat servido de uma pasta num Chromium de celular COM service worker de verdade; Supabase simulado; o servidor entrega um sw.js "antigo" e depois o sw.js real do repositório)
//   -> validação (celular com cópia ANTIGA do chat: cache abaixo de FORCAR_ABAIXO_DE; celular já na versão atual: cache igual ou acima)
//   -> lógica (ao assumir, o service worker novo recarrega SÓ o chat de quem tinha cópia antiga; quem já estava atualizado não é recarregado; /acesso/ e painel nunca são tocados)
//   -> saída (casos PASS/FAIL)
// Versão 1.0 — 25/11/2026 / Mudança: Implementação inicial (atualização forçada nos celulares antigos).
// Dados inventados. Nada fala com o Supabase de verdade.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const RAIZ = resolve(import.meta.dirname, '..');
const UMD = resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const HOST = 'nrvuynjwcgwpjdptkiay.supabase.co';
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const swReal = readFileSync(`${RAIZ}/sw.js`, 'utf8');
const versaoReal = Number((/const VERSAO = 'webchat-cliente-v(\d+)'/.exec(swReal) || [])[1]);
const limite = Number((/const FORCAR_ABAIXO_DE = (\d+)/.exec(swReal) || [])[1]);
const comoVersao = (n) => swReal.replace(`webchat-cliente-v${versaoReal}`, `webchat-cliente-v${n}`);   // o mesmo código com outro número de cópia
let swAtual = comoVersao(70);   // o que o servidor entrega como sw.js agora

function servidor() {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      const c = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      if (c === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache', 'service-worker-allowed': '/' }); res.end(swAtual); return; }
      let a = join(RAIZ, c); if (existsSync(a) && !extname(a)) a = join(a, 'index.html');
      if (!existsSync(a)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404'); return; }
      res.writeHead(200, { 'content-type': TIPOS[extname(a)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(await readFile(a));
    }).listen(0, '127.0.0.1', () => ok(s));
  });
}
const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + e.message.split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };

const srv = await servidor(); const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
async function contexto() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'allow' });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const p = new URL(req.url()).pathname; let corpo = {};
    if (p.endsWith('/rpc/app_porta')) corpo = { ativo: false, obrigatorio: false, local: false };
    else if (p.endsWith('/rpc/app_ativo') || p.endsWith('/rpc/login_paciente_ativo')) corpo = false;
    else if (p.endsWith('/rpc/chat_config')) corpo = { boas_vindas: 'Olá', nome_empresa: 'Clínica' };
    else if (p.endsWith('/rpc/chat_saude')) corpo = { api: true, estado: 'verde', relatorio: true };
    else if (p.startsWith('/rest/v1/') && !p.includes('/rpc/')) corpo = [];
    return rota.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(corpo) });
  });
  return ctx;
}
// Instala o service worker "da época" (cópia v<n>) e deixa o chat aberto, controlado por ele, com uma marca na página para saber se ela foi recarregada.
async function celularComCopia(n) {
  swAtual = comoVersao(n);
  const ctx = await contexto(); const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: 'load' }); await page.evaluate(() => navigator.serviceWorker.ready); await espera(800);
  await page.evaluate(() => { window.__marca = 'mesma-pagina'; });
  return { ctx, page };
}
const chaves = (page) => page.evaluate(async () => (await caches.keys()).sort());
const marca = (page) => page.evaluate(() => window.__marca || null).catch(() => 'navegando');
async function atualizarPara(page, n) {
  swAtual = comoVersao(n);
  await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
  await espera(3500);
}

await caso(`o código real: limite de atualização forçada e versão do cache são coerentes (v${versaoReal}, força abaixo de ${limite})`, async () => ({ ok: versaoReal >= limite && limite > 0, detalhe: `v${versaoReal} limite ${limite}` }));

await caso('celular com cópia ANTIGA (v70) do chat: ao receber o service worker novo, o chat é recarregado sozinho e a cópia antiga é apagada', async () => {
  const { ctx, page } = await celularComCopia(70);
  const antes = await chaves(page);
  await atualizarPara(page, versaoReal);
  const m = await marca(page); 
  const depois = await chaves(page);
  const controlada = await page.evaluate(() => !!navigator.serviceWorker.controller);
  await ctx.close();
  return { ok: m === null && controlada && depois.includes(`webchat-cliente-v${versaoReal}`) && !depois.includes('webchat-cliente-v70'), detalhe: `marca=${m} antes=${antes} depois=${depois}` };
});

await caso(`celular que já estava na versão atual (v${versaoReal}) e recebe uma publicação nova: NÃO é recarregado (a atualização educada de sempre)`, async () => {
  const { ctx, page } = await celularComCopia(versaoReal);
  await atualizarPara(page, versaoReal + 1);
  const m = await marca(page); const depois = await chaves(page);
  await ctx.close();
  return { ok: m === 'mesma-pagina' && depois.includes(`webchat-cliente-v${versaoReal + 1}`), detalhe: `marca=${m} caches=${depois}` };
});

await caso('quem abre o site pela primeira vez (sem cópia antiga) não é recarregado pelo service worker', async () => {
  swAtual = comoVersao(versaoReal);
  const ctx = await contexto(); const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: 'load' }); await page.evaluate(() => { window.__marca = 'mesma-pagina'; }); await page.evaluate(() => navigator.serviceWorker.ready); await espera(2500);
  const m = await marca(page); await ctx.close();
  return { ok: m === 'mesma-pagina', detalhe: `marca=${m}` };
});

await caso('a página /acesso/ aberta em outra aba NUNCA é recarregada pela atualização forçada (só o chat)', async () => {
  const { ctx, page } = await celularComCopia(70);
  const acesso = await ctx.newPage(); await acesso.goto(`${base}/acesso/`, { waitUntil: 'load' }); await espera(800);
  await acesso.evaluate(() => { window.__marca = 'acesso-intacto'; });
  await atualizarPara(page, versaoReal);
  const ma = await marca(acesso), mc = await marca(page); await ctx.close();
  return { ok: ma === 'acesso-intacto' && mc === null, detalhe: `acesso=${ma} chat=${mc}` };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
