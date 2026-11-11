// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com o cardápio) -> validação (só administrador vê a aba) -> lógica (cardápio só Particular: nome do exame e valor digitado, salvar, remover, filtros, mostrar mais, sub-aba de limpeza) -> saída (PASS/FAIL e código de saída)
// Versão 2.0 — 11/11/2026 / Mudança: cardápio simplificado (só Particular, valor digitado ao lado do exame; convênios saem da tela)
//
// Não substitui o teste com o Supabase real: a função do banco é simulada aqui (os dados reais foram conferidos à mão com catalogo_cardapio_dados).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const RAIZ = resolve(import.meta.dirname, '..');
const UMD = resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const HOST = 'nrvuynjwcgwpjdptkiay.supabase.co';
const EU = { id: '11111111-1111-4111-8111-111111111111', nome: 'Atendente de Teste', email: 'a@teste.local', papel: 'admin', ativo: true };
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const agora = new Date().toISOString();
const jwt = (sub) => { const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.x`; };

const EXAMES = [
  { id: 1, nome: 'USG TRANSVAGINAL', especialidade: 'ULTRASSONOGRAFIA', valor: 910 },
  { id: 2, nome: 'MAMOGRAFIA BILATERAL', especialidade: 'MAMOGRAFIA', valor: null },
  { id: 3, nome: 'RESSONANCIA DE JOELHO', especialidade: 'RESSONANCIA', valor: null },
];
let ultimoPedido = null;
const SALVOS = [];

function servidor() {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      const c = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let a = join(RAIZ, c); if (existsSync(a) && !extname(a)) a = join(a, 'index.html');
      if (!existsSync(a)) { res.writeHead(404); res.end('x'); return; }
      res.writeHead(200, { 'content-type': TIPOS[extname(a)] ?? 'application/octet-stream' }); res.end(await readFile(a));
    }).listen(0, '127.0.0.1', () => ok(s));
  });
}

async function pagina(browser, { papel = 'admin' } = {}) {
  EU.papel = papel;
  const ctx = await browser.newContext();
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.modo'); } catch {}
  }, [EU.id, jwt(EU.id), EU.email]);
  const reg = { excecoes: [], chamadas: [] };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => reg.excecoes.push(e.message));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: require('node:fs').readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url()); const p = url.pathname;
    const objeto = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    let corpo;
    if (p.startsWith('/auth/v1/user')) corpo = { id: EU.id, aud: 'authenticated', role: 'authenticated', email: EU.email };
    else if (p.startsWith('/rest/v1/agentes')) corpo = url.searchParams.get('id') ? (objeto ? EU : [EU]) : [EU];
    else if (p.endsWith('/rpc/catalogo_particular_lista')) {
      const q = JSON.parse(req.postData() || '{}'); ultimoPedido = q; reg.chamadas.push(q);
      let ex = EXAMES.filter((x) => !q.p_busca || x.nome.toLowerCase().includes(String(q.p_busca).toLowerCase()));
      if (q.p_filtro === 'sem_valor') ex = ex.filter((x) => x.valor == null);
      if (q.p_filtro === 'com_valor') ex = ex.filter((x) => x.valor != null);
      corpo = { total: ex.length, com_valor: ex.filter((x) => x.valor != null).length, itens: ex };
    }
    else if (p.endsWith('/rpc/catalogo_particular_salvar')) { SALVOS.push(JSON.parse(req.postData() || '{}')); corpo = { ok: true }; }
    else if (p.endsWith('/rpc/catalogo_limpeza')) corpo = { ativos: 2150, removidos: 0, sem_preparo: 2148, sem_agenda_vigente: { total: 3, exemplos: [] }, sem_preco_com_agenda: { total: 1, exemplos: [] }, mais_pedidos_sem_preparo: [], nomes_duplicados: [], agenda_teste: { linhas: 0, profissionais: [] } };
    else if (p.endsWith('/rpc/catalogo_mudancas')) corpo = [];
    else if (p.startsWith('/rest/v1/rpc/')) corpo = {};
    else if (p.startsWith('/rest/v1/')) corpo = objeto ? null : [];
    else corpo = {};
    return rota.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(corpo) });
  });
  if (typeof page.routeWebSocket === 'function') await page.routeWebSocket(/supabase\.co/, (ws) => ws.close());
  return { page, ctx, reg };
}

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + e.message.split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});

const abrir = async (browser, papel) => {
  const r = await pagina(browser, papel ? { papel } : {});
  await r.page.goto(`${base}/painel/`);
  await r.page.click('.nav button[data-aba=catalogo]');
  await r.page.waitForSelector('.cd-tabela input');
  return r;
};

await caso('mostra só exame e valor Particular, sem nada de convênio', async () => {
  const { page, ctx, reg } = await abrir(browser);
  const txt = await page.locator('.pagina').innerText();
  const campos = await page.locator('.cd-tabela input').count();
  const v1 = await page.locator('.cd-tabela input').first().inputValue();
  await ctx.close();
  return { ok: reg.excecoes.length === 0 && /USG TRANSVAGINAL/.test(txt) && campos === 3 && v1 === '910' && !/Operadora|UNIMED|Bradesco|Amil/i.test(txt), detalhe: `${campos} campos, primeiro=${v1} ${reg.excecoes.join(';')}` };
});

await caso('digitar o valor e salvar chama o banco com o exame e o número', async () => {
  const { page, ctx } = await abrir(browser);
  SALVOS.length = 0;
  const campo = page.locator('.cd-tabela tbody tr', { hasText: 'MAMOGRAFIA' }).locator('input');
  await campo.fill('1.250,50');
  await page.locator('.cd-tabela tbody tr', { hasText: 'MAMOGRAFIA' }).getByRole('button', { name: 'Salvar' }).click();
  await page.waitForTimeout(300);
  await ctx.close();
  return { ok: SALVOS.length === 1 && SALVOS[0].p_procedimento === 2 && SALVOS[0].p_valor === 1250.5, detalhe: JSON.stringify(SALVOS) };
});

await caso('campo vazio remove o valor (manda nulo)', async () => {
  const { page, ctx } = await abrir(browser);
  SALVOS.length = 0;
  const linha = page.locator('.cd-tabela tbody tr', { hasText: 'USG' });
  await linha.locator('input').fill('');
  await linha.getByRole('button', { name: 'Salvar' }).click();
  await page.waitForTimeout(300);
  await ctx.close();
  return { ok: SALVOS.length === 1 && SALVOS[0].p_procedimento === 1 && SALVOS[0].p_valor === null, detalhe: JSON.stringify(SALVOS) };
});

await caso('valor inválido não chega ao banco', async () => {
  const { page, ctx } = await abrir(browser);
  SALVOS.length = 0;
  const linha = page.locator('.cd-tabela tbody tr', { hasText: 'MAMOGRAFIA' });
  await linha.locator('input').fill('abc');
  await linha.getByRole('button', { name: 'Salvar' }).click();
  await linha.locator('input').fill('2');
  await linha.getByRole('button', { name: 'Salvar' }).click();
  await page.waitForTimeout(300);
  await ctx.close();
  return { ok: SALVOS.length === 0, detalhe: JSON.stringify(SALVOS) };
});

await caso('busca e filtro "só sem valor" chegam ao banco', async () => {
  const { page, ctx } = await abrir(browser);
  await page.fill('input[aria-label="Procurar exame"]', 'joelho');
  await page.waitForTimeout(600);
  const achou = await page.locator('.cd-tabela tbody tr').count();
  const pedido1 = JSON.stringify(ultimoPedido);
  await page.fill('input[aria-label="Procurar exame"]', '');
  await page.selectOption('select[aria-label=Mostrar]', 'sem_valor');
  await page.waitForTimeout(600);
  const semValor = await page.locator('.cd-tabela tbody tr').count();
  await ctx.close();
  return { ok: achou === 1 && /joelho/.test(pedido1) && semValor === 2 && ultimoPedido.p_filtro === 'sem_valor', detalhe: `${achou}/${semValor} ${pedido1}` };
});

await caso('sub-aba "Limpeza e mudanças" continua mostrando o que já existia', async () => {
  const { page, ctx, reg } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=catalogo]');
  await page.waitForSelector('.cd-tabela');
  await page.click('button.chip:text-is("Limpeza e mudanças")');
  await page.waitForSelector('.numeros .num');
  const txt = await page.locator('.pagina').innerText();
  await ctx.close();
  return { ok: reg.excecoes.length === 0 && /2150/.test(txt) && /procedimentos ativos/.test(txt) && /O que mudou/.test(txt), detalhe: reg.excecoes.join(';') };
});

await caso('atendente não vê a aba Catálogo', async () => {
  const { page, ctx } = await pagina(browser, { papel: 'atendente' });
  await page.goto(`${base}/painel/`);
  await page.waitForSelector('.nav button');
  const tem = await page.locator('.nav button[data-aba=catalogo]').count();
  await ctx.close();
  return { ok: tem === 0, detalhe: String(tem) };
});

await browser.close(); srv.close();
const falhas = resultados.filter((r) => !r).length;
console.log(falhas ? `\n${falhas} FALHA(S)` : `\nOK: ${resultados.length} testes`);
process.exit(falhas ? 1 : 0);
