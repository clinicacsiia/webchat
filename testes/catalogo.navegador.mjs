// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com o cardápio) -> validação (só administrador vê a aba) -> lógica (cardápio com preço por operadora, "!" quando o Klingo diverge, previsão, filtros, mostrar mais, sub-aba de limpeza) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 05/11/2026 / Mudança: Implementação inicial (cardápio de preços da aba Catálogo)
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

const lin = (operadora, estado, extra = {}) => ({ operadora, particular: operadora === 'PARTICULAR', tabela: null, tabelas: 1, estado, catalogo: null, exibido: null, observado: null, obs_min: null, obs_max: null, amostras: null, dif_pct: null, ...extra });
const EXAMES = [
  { id: 1, nome: 'USG TRANSVAGINAL', especialidade: 'ULTRASSONOGRAFIA', marcacoes_90d: 1794, alertas: 1, previsoes: 1, sem_preco: 0, linhas: [
    lin('UNIMED', 'divergente', { catalogo: 790, exibido: 1042.08, observado: 1042.08, obs_min: 1042.08, obs_max: 1042.08, amostras: 1, dif_pct: 31.9 }),
    lin('PARTICULAR', 'ok', { catalogo: 910, exibido: 910, observado: 910, amostras: 1, dif_pct: 0 }),
    lin('BRADESCO', 'previsao', { exibido: 340.93, observado: 340.93, obs_min: 300, obs_max: 340.93, amostras: 3 })] },
  { id: 2, nome: 'MAMOGRAFIA BILATERAL', especialidade: 'MAMOGRAFIA', marcacoes_90d: 721, alertas: 0, previsoes: 0, sem_preco: 1, linhas: [
    lin('AMIL', 'ok', { catalogo: 65.16, exibido: 65.16 }), lin('MARINHA', 'sem_preco')] },
  { id: 3, nome: 'RESSONANCIA DE JOELHO', especialidade: 'RESSONANCIA', marcacoes_90d: 460, alertas: 1, previsoes: 0, sem_preco: 0, ligadas: 2, linhas: [
    lin('HAPVIDA', 'ok', { catalogo: 340, exibido: 340, observado: 340, amostras: 18, dif_pct: 0, revisao: { ligado: true, valor: 300, nota: 'Tabela antiga', em: agora, por: 'Maria', mudou: true } }),
    lin('AMIL', 'ok', { catalogo: 340, exibido: 340, revisao: { ligado: true, valor: 340, nota: null, em: agora, por: 'Maria', mudou: false } })] },
];
let ultimoPedido = null;
const REVISOES = [];

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
    else if (p.endsWith('/rpc/catalogo_cardapio')) {
      const q = JSON.parse(req.postData() || '{}'); ultimoPedido = q; reg.chamadas.push(q);
      let ex = EXAMES.filter((x) => !q.p_busca || x.nome.toLowerCase().includes(String(q.p_busca).toLowerCase()));
      if (q.p_filtro === 'alerta') ex = ex.filter((x) => x.alertas > 0);
      corpo = { limite_pct: 10, exames_total: ex.length, exames_com_alerta: ex.filter((x) => x.alertas > 0).length, exames_com_previsao: ex.filter((x) => x.previsoes > 0).length, preco_lido_em: agora, catalogo_em: agora, exames: ex };
    }
    else if (p.endsWith('/rpc/catalogo_preco_revisar')) { REVISOES.push(JSON.parse(req.postData() || '{}')); corpo = { ok: true }; }
    else if (p.endsWith('/rpc/catalogo_cardapio_operadoras')) corpo = ['AMIL', 'PARTICULAR', 'UNIMED'];
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

await caso('administrador abre o cardápio: aviso de previsão, exame com "!" aberto e valor lançado marcado como previsão', async () => {
  const { page, ctx, reg } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=catalogo]');
  await page.waitForSelector('.cat-bloco');
  const aviso = await page.locator('.cd-aviso').innerText();
  const nomes = (await page.locator('.cat-bloco > summary').allInnerTexts()).map((t) => t.split('·')[0].trim());
  const aberto = await page.locator('.cat-bloco:has-text("USG TRANSVAGINAL")').evaluate((d) => d.open);
  const fechado = await page.locator('.cat-bloco:has-text("MAMOGRAFIA")').evaluate((d) => d.open);
  const linhaDiv = await page.locator('.cat-bloco:has-text("USG TRANSVAGINAL") tr.cd-div').innerText();
  const alertas = await page.locator('.cat-bloco:has-text("USG TRANSVAGINAL") .cd-tabela tr.cd-div .cd-alerta').count();
  await ctx.close();
  const ok = reg.excecoes.length === 0 && /previsão/.test(aviso) && nomes.length === 3 && /USG TRANSVAGINAL/.test(nomes[0]) && aberto && !fechado && alertas === 1
    && /1\.042,08/.test(linhaDiv) && /previsão/.test(linhaDiv) && /\+31,9%/.test(linhaDiv) && /790,00/.test(linhaDiv);
  return { ok, detalhe: `${nomes.join(' | ')} | aberto=${aberto} fechado=${fechado} | alertas=${alertas} | ${linhaDiv.replace(/\s+/g, ' ')} | ${reg.excecoes.join(';')}` };
});

await caso('linha sem alerta mostra o preço do catálogo; previsão e sem preço aparecem como tal', async () => {
  const { page, ctx } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=catalogo]');
  await page.waitForSelector('.cat-bloco');
  await page.locator('.cat-bloco:has-text("MAMOGRAFIA") summary').click();
  const amil = await page.locator('.cat-bloco:has-text("MAMOGRAFIA") tr:has-text("AMIL")').innerText();
  const marinha = await page.locator('.cat-bloco:has-text("MAMOGRAFIA") tr:has-text("MARINHA")').innerText();
  const brad = await page.locator('.cat-bloco:has-text("USG") tr:has-text("BRADESCO")').innerText();
  const part = await page.locator('.cat-bloco:has-text("USG") tbody tr').first().innerText();
  await ctx.close();
  return { ok: /65,16/.test(amil) && !/previsão/.test(amil) && /Sem preço confiável/.test(marinha) && /previsão/.test(brad) && /variou de/.test(brad) && /^Particular/.test(part),
    detalhe: `${amil.replace(/\s+/g, ' ')} | ${marinha.replace(/\s+/g, ' ')} | ${brad.replace(/\s+/g, ' ')} | 1ª linha: ${part.slice(0, 12)}` };
});

await caso('busca e filtro "só com alerta" chamam o banco com os parâmetros certos', async () => {
  const { page, ctx, reg } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=catalogo]');
  await page.waitForSelector('.cat-bloco');
  await page.selectOption('select[aria-label="Mostrar"]', 'alerta');
  await page.waitForFunction(() => document.querySelectorAll('.cat-bloco').length === 2);
  await page.fill('input[aria-label="Procurar exame"]', 'usg');
  await page.waitForFunction(() => /USG/.test(document.querySelector('.cat-bloco > summary')?.textContent || ''));
  await page.selectOption('select[aria-label="Operadora"]', 'UNIMED');
  await page.waitForTimeout(400);
  const ult = reg.chamadas[reg.chamadas.length - 1];
  await ctx.close();
  return { ok: ult.p_filtro === 'alerta' && ult.p_busca === 'usg' && ult.p_operadora === 'UNIMED', detalhe: JSON.stringify(ult) };
});

const abrir = async (page, nome) => {
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=catalogo]');
  await page.waitForSelector('.cat-bloco');
  const d = page.locator(`.cat-bloco:has-text("${nome}")`);
  if (!(await d.evaluate((e) => e.open))) await d.locator('summary').click();
  return d;
};

await caso('referência que mudou depois da confirmação: "!" e aviso; o chat segue com o valor confirmado', async () => {
  const { page, ctx } = await pagina(browser);
  const d = await abrir(page, 'RESSONANCIA');
  const hap = d.locator('tr:has-text("HAPVIDA")'), amil = d.locator('tr:has-text("AMIL")');
  const txt = await hap.innerText();
  const aberto = await d.evaluate((e) => e.open);
  const alertasAmil = await amil.locator('.cd-alerta').count();
  const ligado = await hap.locator('input[role=switch]').isChecked();
  await ctx.close();
  return { ok: aberto && ligado && /300,00/.test(txt) && /referência mudou/.test(txt) && /até você revisar/.test(txt) && /Tabela antiga/.test(txt) && alertasAmil === 0, detalhe: txt.replace(/\s+/g, ' ') };
});

await caso('ligar pelo interruptor pede confirmação e grava o valor que a tela mostrava', async () => {
  const { page, ctx } = await pagina(browser);
  REVISOES.length = 0;
  let aviso = '';
  page.on('dialog', async (dl) => { aviso = dl.message(); await dl.accept(); });
  const d = await abrir(page, 'USG TRANSVAGINAL');
  await d.locator('tr:has-text("Particular") input[role=switch]').check();
  await page.waitForFunction(() => true); await page.waitForTimeout(300);
  const r = REVISOES[0] || {};
  await ctx.close();
  return { ok: /910,00/.test(aviso) && /previsão/.test(aviso) && r.p_procedimento === 1 && r.p_operadora === 'PARTICULAR' && r.p_ligado === true && r.p_valor === 910 && r.p_referencia === 910, detalhe: `${aviso} | ${JSON.stringify(r)}` };
});

await caso('cancelar na confirmação não grava nada e o interruptor volta', async () => {
  const { page, ctx } = await pagina(browser);
  REVISOES.length = 0;
  page.on('dialog', (dl) => dl.dismiss());
  const d = await abrir(page, 'USG TRANSVAGINAL');
  const sw = d.locator('tr:has-text("Particular") input[role=switch]');
  await sw.click();
  await page.waitForTimeout(300);
  const marcado = await sw.isChecked();
  await ctx.close();
  return { ok: REVISOES.length === 0 && marcado === false, detalhe: `chamadas=${REVISOES.length} marcado=${marcado}` };
});

await caso('desligar um preço ligado chama o banco com ligado:false', async () => {
  const { page, ctx } = await pagina(browser);
  REVISOES.length = 0;
  const d = await abrir(page, 'RESSONANCIA');
  await d.locator('tr:has-text("AMIL") input[role=switch]').uncheck();
  await page.waitForTimeout(300);
  const r = REVISOES[0] || {};
  await ctx.close();
  return { ok: r.p_ligado === false && r.p_operadora === 'AMIL' && r.p_procedimento === 3, detalhe: JSON.stringify(r) };
});

await caso('linha sem preço: ligar abre o campo de valor; corrigir e salvar grava o valor digitado', async () => {
  const { page, ctx } = await pagina(browser);
  REVISOES.length = 0;
  page.on('dialog', (dl) => dl.accept());
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=catalogo]');
  await page.waitForSelector('.cat-bloco');
  const d = page.locator('.cat-bloco:has-text("MAMOGRAFIA")');
  await d.locator('summary').click();
  await d.locator('tr:has-text("MARINHA") input[role=switch]').click();
  const campo = d.locator('tr:has-text("MARINHA") input[aria-label="Valor que o chat informa"]');
  await campo.waitFor();
  await campo.fill('123,45');
  await d.locator('tr:has-text("MARINHA") input[aria-label="Nota"]').fill('Valor da tabela nova');
  await d.locator('tr:has-text("MARINHA") button:text-is("Salvar e ligar")').click();
  await page.waitForTimeout(300);
  const r = REVISOES[0] || {};
  const depois = await d.locator('tr:has-text("MARINHA")').innerText();
  await ctx.close();
  return { ok: r.p_valor === 123.45 && r.p_ligado === true && r.p_nota === 'Valor da tabela nova' && r.p_referencia === null && /123,45/.test(depois) && /Ligado/.test(depois), detalhe: `${JSON.stringify(r)} | ${depois.replace(/\s+/g, ' ')}` };
});

await caso('valor inválido não chega ao banco', async () => {
  const { page, ctx } = await pagina(browser);
  REVISOES.length = 0;
  page.on('dialog', (dl) => dl.accept());
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=catalogo]');
  await page.waitForSelector('.cat-bloco');
  const d = page.locator('.cat-bloco:has-text("MAMOGRAFIA")');
  await d.locator('summary').click();
  await d.locator('tr:has-text("MARINHA") input[role=switch]').click();
  const campo = d.locator('tr:has-text("MARINHA") input[aria-label="Valor que o chat informa"]');
  await campo.fill('1');
  await d.locator('tr:has-text("MARINHA") button:text-is("Salvar e ligar")').click();
  await page.waitForTimeout(300);
  await ctx.close();
  return { ok: REVISOES.length === 0, detalhe: `chamadas=${REVISOES.length}` };
});

await caso('sub-aba "Limpeza e mudanças" continua mostrando o que já existia', async () => {
  const { page, ctx, reg } = await pagina(browser);
  await page.goto(`${base}/painel/`);
  await page.click('.nav button[data-aba=catalogo]');
  await page.waitForSelector('.cat-bloco');
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
