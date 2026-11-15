// FLUXOGRAMA: entrada (o chat e a página /acesso/ servidos de uma pasta, num Chromium de celular COM service worker de verdade; Supabase simulado: PIN obrigatório ligado) -> validação (1ª visita registra o service worker; 2ª visita já é controlada por ele) -> lógica (sem cadastro neste aparelho o chat tem de levar à porta do PIN no endereço certo, e a página de acesso tem de vir da rede, nunca a cópia do chat) -> saída (casos PASS/FAIL)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial. Por que existe: em 15/11/2026 quem já tinha o service worker abria o chat SEM PIN (o service worker respondia /acesso/ com a cópia do chat, o chat tentava ir para acesso/acesso/ e, depois de 3 voltas, a trava de laço abria o chat). Os outros testes de navegador rodam sem service worker e não viam isso.
// Dados inventados. Nada fala com o Supabase de verdade. Para testar outra cópia do código: RAIZ_CHAT=/caminho node acesso-sw.navegador.mjs
// DEPOIS DE CADA PUBLICAÇÃO, conferir o site de verdade (só abre páginas e lê, não grava nada): URL_VIVO=https://clinicacsiia.github.io/webchat npm run test:ao-vivo-pin
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const RAIZ = process.env.RAIZ_CHAT ? resolve(process.env.RAIZ_CHAT) : resolve(import.meta.dirname, '..');
const UMD = resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const HOST = 'nrvuynjwcgwpjdptkiay.supabase.co';
const VIVO = (process.env.URL_VIVO || '').replace(/\/+$/, '');   // endereço do site publicado; vazio = pasta local com Supabase simulado
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

function servidor() {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      const c = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let a = join(RAIZ, c); if (existsSync(a) && !extname(a)) a = join(a, 'index.html');
      if (!existsSync(a)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('404'); return; }
      res.writeHead(200, { 'content-type': TIPOS[extname(a)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(await readFile(a));
    }).listen(0, '127.0.0.1', () => ok(s));
  });
}

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + e.message.split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };

const srv = await servidor();
const base = VIVO || `http://127.0.0.1:${srv.address().port}`;
const PORTA = new URL(`${base}/acesso/?voltar=chat`), CAMINHO_PORTA = PORTA.pathname + PORTA.search, CAMINHO_ACESSO = PORTA.pathname;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

async function contexto() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, serviceWorkers: 'allow' });
  if (VIVO) return ctx;   // site de verdade: nada é simulado
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: require('node:fs').readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const p = new URL(req.url()).pathname; let corpo = {};
    if (p.endsWith('/rpc/app_porta')) corpo = { ativo: true, obrigatorio: true, local: false };
    else if (p.endsWith('/rpc/app_ativo') || p.endsWith('/rpc/login_paciente_ativo')) corpo = true;
    else if (p.endsWith('/rpc/chat_config')) corpo = { boas_vindas: 'Olá', nome_empresa: 'Clínica' };
    else if (p.endsWith('/rpc/chat_saude')) corpo = { api: true, estado: 'verde', relatorio: true };
    else if (p.startsWith('/rest/v1/') && !p.includes('/rpc/')) corpo = [];
    return rota.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(corpo) });
  });
  if (typeof (await ctx.newPage()).routeWebSocket === 'function') { /* sem tempo real neste teste */ }
  return ctx;
}

await caso('com o service worker ATIVO, o chat sem cadastro leva à página do PIN no endereço certo (/acesso/?voltar=chat), sem "acesso/acesso" e sem abrir o chat', async () => {
  const ctx = await contexto(); const page = await ctx.newPage();
  const navegou = []; page.on('framenavigated', (f) => { if (f === page.mainFrame()) navegou.push(new URL(f.url()).pathname + new URL(f.url()).search); });
  // 1ª visita: instala o service worker (e já vai para a porta)
  await page.goto(`${base}/`, { waitUntil: 'load' }); await espera(2500);
  await page.evaluate(() => navigator.serviceWorker.ready); await espera(500);
  // 2ª visita: agora o service worker responde pela navegação
  await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear(); } catch { /* ignora */ } });
  navegou.length = 0;
  await page.goto(`${base}/`, { waitUntil: 'load' }); await espera(5000);
  const controlada = await page.evaluate(() => !!navigator.serviceWorker.controller);
  const url = new URL(page.url()), caminho = url.pathname + url.search;
  const texto = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const naPorta = caminho === CAMINHO_PORTA && /Vamos começar|celular/i.test(texto) && !/acesso\/acesso/.test(navegou.join(' '));
  await ctx.close();
  return { ok: controlada && naPorta, detalhe: `controlada=${controlada} url=${caminho} navegou=${navegou.join(' > ')} texto="${texto.slice(0, 60)}"` };
});

await caso('com o service worker ATIVO, abrir /acesso/ direto mostra a página do PIN (da rede), não a cópia do chat', async () => {
  const ctx = await contexto(); const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: 'load' }); await espera(2500);
  await page.evaluate(() => navigator.serviceWorker.ready); await espera(500);
  await page.goto(`${base}/acesso/?voltar=chat`, { waitUntil: 'load' }); await espera(2500);
  const url = new URL(page.url()), texto = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const temChat = await page.locator('#formInicio').count();
  await ctx.close();
  return { ok: url.pathname === CAMINHO_ACESSO && temChat === 0 && /celular/i.test(texto), detalhe: `${url.pathname} formDoChat=${temChat} texto="${texto.slice(0, 60)}"` };
});

await caso('com o service worker ATIVO, a política de privacidade abre a política (não a cópia do chat)', async () => {
  const ctx = await contexto(); const page = await ctx.newPage();
  await page.goto(`${base}/`, { waitUntil: 'load' }); await espera(2500);
  await page.evaluate(() => navigator.serviceWorker.ready); await espera(500);
  await page.goto(`${base}/privacidade.html`, { waitUntil: 'load' }); await espera(1500);
  const h1 = (await page.locator('h1').first().innerText().catch(() => '')).trim(), temChat = await page.locator('#formInicio').count();
  await ctx.close();
  return { ok: /privacidade/i.test(h1) && temChat === 0, detalhe: `h1="${h1}" formDoChat=${temChat}` };
});

await browser.close(); srv.close();
const falhas = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} passaram.`);
process.exit(falhas ? 1 : 0);
