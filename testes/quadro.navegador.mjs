// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com conversas e cartões) -> validação (o quadro é uma forma de ver o Atendimento, não uma aba) -> lógica (alternador Lista/Quadro, colunas, filtros, abrir a conversa, mover pela barra do cartão, quadro indisponível) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
//
// Não substitui o teste com o Supabase real: as funções do banco são simuladas aqui (o banco tem teste próprio).
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
const EU = { id: '11111111-1111-4111-8111-111111111111', nome: 'Atendente de Teste', email: 'a@teste.local', papel: 'atendente', ativo: true };
const OUTRO = { id: '22222222-2222-4222-8222-222222222222', nome: 'Outra Pessoa', email: 'o@teste.local', papel: 'atendente', ativo: true };
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const agora = new Date().toISOString();

const conversa = (id, nome, status, agente) => ({ id, status, agente_id: agente, ultima_mensagem: 'oi', nao_lidas_agente: 0, criado_em: agora, atualizado_em: agora, contato_id: 'ct-' + id, ia_ativa: false, motor: 'fluxo',
  triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null, contatos: { id: 'ct-' + id, nome, telefone: '71900000000', email: null } });
const CONVERSAS = [conversa('c1', 'Maria Souza', 'aguardando', null), conversa('c2', 'João Lima', 'em_atendimento', EU.id), conversa('c3', 'Ana Paula', 'em_atendimento', OUTRO.id)];
const COLUNAS = [['contato', 'Em conversa no chat', 1, 'manual'], ['orcamento', 'Pedido pronto', 2, 'manual'], ['autorizacao', 'Aguardando autorização', 3, 'manual'], ['agendado', 'Agendado (veio do chat)', 4, 'klingo'], ['perdido', 'Perdido', 23, 'manual']]
  .map(([id, nome, ordem, origem]) => ({ id, nome, ordem, origem }));
const TRANS = [['contato', 'orcamento'], ['contato', 'autorizacao'], ['contato', 'perdido'], ['orcamento', 'autorizacao'], ['orcamento', 'perdido'], ['perdido', 'contato']].map(([de, para]) => ({ de, para }));
const card = (id, conv, nome, coluna, extra = {}) => ({ id, paciente_nome: nome, coluna, data_ref: '2026-11-01', unidade: 'CSI 1', coluna_desde: agora, responsavel: null, prioridade: 0, versao: 1, conversa_id: conv,
  primeiro_exame: 'Ressonância de joelho', n_ativos: 1, atrasado: false, n_tarefas_abertas: 0, n_tarefas_vencidas: 0, proxima_hora: null, ...extra });
const CARTOES = [card(1, 'c1', 'Maria Souza', 'contato', { atrasado: true }), card(2, 'c2', 'João Lima', 'orcamento', { responsavel: EU.id, n_ativos: 2 }), card(3, 'c3', 'Ana Paula', 'agendado')];

const jwt = (sub) => { const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url'); return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.x`; };

function servidor() {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      let c = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let a = join(RAIZ, c); if (existsSync(a) && !extname(a)) a = join(a, 'index.html');
      if (!existsSync(a)) { res.writeHead(404); res.end('x'); return; }
      res.writeHead(200, { 'content-type': TIPOS[extname(a)] ?? 'application/octet-stream' }); res.end(await readFile(a));
    }).listen(0, '127.0.0.1', () => ok(s));
  });
}

async function pagina(browser, { quadroIndisponivel = false } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.modo'); } catch {}
  }, [EU.id, jwt(EU.id), EU.email]);
  const reg = { excecoes: [], pedidos: [], rpcs: [] };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => reg.excecoes.push(e.message));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: require('node:fs').readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url()); const p = url.pathname;
    const objeto = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    reg.pedidos.push(p + url.search);
    let corpo; let status = 200;
    if (p.startsWith('/auth/v1/user')) corpo = { id: EU.id, aud: 'authenticated', role: 'authenticated', email: EU.email };
    else if (p.startsWith('/rest/v1/agentes')) corpo = url.searchParams.get('id') ? (objeto ? EU : [EU]) : [EU, OUTRO];
    else if (p.startsWith('/rest/v1/conversas')) corpo = CONVERSAS;
    else if (p.startsWith('/rest/v1/jornada_coluna')) corpo = COLUNAS;
    else if (p.startsWith('/rest/v1/jornada_transicao')) corpo = TRANS;
    else if (p.startsWith('/rest/v1/v_jornada_quadro')) { if (quadroIndisponivel) { status = 404; corpo = { message: 'relation "v_jornada_quadro" does not exist' }; } else corpo = CARTOES; }
    else if (p.endsWith('/rpc/jornada_mover_card')) { reg.rpcs.push(JSON.parse(req.postData() || '{}')); corpo = { ok: true, versao: 2 }; }
    else if (p.startsWith('/rest/v1/rpc/')) corpo = {};
    else if (p.startsWith('/rest/v1/')) corpo = objeto ? null : [];
    else corpo = {};
    return rota.fulfill({ status, headers: CORS, contentType: 'application/json', body: JSON.stringify(corpo) });
  });
  if (typeof page.routeWebSocket === 'function') await page.routeWebSocket(/supabase\.co/, (ws) => ws.close());
  return { page, ctx, reg };
}

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + e.message.split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const abrir = async (opcoes) => { const t = await pagina(browser, opcoes); await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('.modo', { timeout: 10000 }); return t; };
const nomesNaColuna = (page, col) => page.locator(`.q-col[data-coluna="${col}"] .q-card b`).allInnerTexts();

await caso('não existe aba "Jornada": o quadro é uma função do Atendimento', async () => {
  const { page, ctx, reg } = await abrir();
  const abas = await page.locator('nav.nav button').evaluateAll((b) => b.map((x) => x.dataset.aba));
  await ctx.close();
  return { ok: !abas.some((a) => /jornada|quadro/i.test(a)) && abas.includes('atendimento') && !reg.excecoes.length, detalhe: abas.join(',') };
});

await caso('Lista é o modo padrão e o quadro não é carregado antes de pedir', async () => {
  const { page, ctx, reg } = await abrir();
  const emLista = await page.locator('.modo button[aria-pressed=true]').innerText();
  const pediu = reg.pedidos.some((p) => p.includes('v_jornada_quadro'));
  await ctx.close();
  return { ok: emLista === 'Lista' && !pediu, detalhe: `modo=${emLista}, pediu quadro=${pediu}` };
});

await caso('Quadro: mostra as colunas com os cartões das conversas e só pede cartões que têm conversa', async () => {
  const { page, ctx, reg } = await abrir();
  await page.click('.modo button:has-text("Quadro")');
  await page.waitForSelector('.q-col', { timeout: 5000 });
  const c1 = await nomesNaColuna(page, 'contato'), c2 = await nomesNaColuna(page, 'orcamento'), c3 = await nomesNaColuna(page, 'agendado');
  const pedido = reg.pedidos.find((p) => p.includes('v_jornada_quadro')) ?? '';
  const salvo = await page.evaluate(() => localStorage.getItem('painel.modo'));
  await ctx.close();
  const ok = c1.join() === 'Maria Souza' && c2.join() === 'João Lima' && c3.join() === 'Ana Paula' && /conversa_id=not\.is\.null/.test(pedido) && salvo === 'quadro' && !reg.excecoes.length;
  return { ok, detalhe: reg.excecoes[0] ?? `${c1}|${c2}|${c3}; filtro=${/conversa_id=not\.is\.null/.test(pedido)}` };
});

await caso('Quadro: filtros Meus, Aguardando e Atrasados e busca', async () => {
  const { page, ctx } = await abrir();
  await page.click('.modo button:has-text("Quadro")'); await page.waitForSelector('.q-col');
  const todos = async () => (await page.locator('.q-card b').allInnerTexts()).sort().join(',');
  await page.click('.q-topo .chip:has-text("Meus")'); const meus = await todos();
  await page.click('.q-topo .chip:has-text("Aguardando")'); const ag = await todos();
  await page.click('.q-topo .chip:has-text("Atrasados")'); const at = await todos();
  await page.click('.q-topo .chip:has-text("Todos")');
  await page.fill('.q-topo input[type=search]', 'joao'); await page.waitForTimeout(450); const busca = await todos();
  await ctx.close();
  return { ok: meus === 'João Lima' && ag === 'Maria Souza' && at === 'Maria Souza' && busca === 'João Lima', detalhe: `${meus}|${ag}|${at}|${busca}` };
});

await caso('Clicar no cartão abre a conversa ao lado e mostra a etapa e o "Mover para"', async () => {
  const { page, ctx, reg } = await abrir();
  await page.click('.modo button:has-text("Quadro")'); await page.waitForSelector('.q-col');
  await page.click('.q-card:has-text("Maria Souza")');
  await page.waitForSelector('.cartaoJ', { timeout: 5000 });
  const barra = await page.locator('.cartaoJ').innerText();
  const opcoes = await page.locator('.cartaoJ select').first().locator('option').allInnerTexts();
  const topo = await page.locator('#chatTopo').innerText();
  await ctx.close();
  return { ok: /Em conversa no chat/.test(barra) && opcoes.includes('Pedido pronto') && opcoes.includes('Perdido') && !opcoes.includes('Agendado (veio do chat)') && /Maria Souza/.test(topo) && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? opcoes.join('/') };
});

await caso('Mover pela barra chama jornada_mover_card com a versão do cartão', async () => {
  const { page, ctx, reg } = await abrir();
  await page.click('.modo button:has-text("Quadro")'); await page.waitForSelector('.q-col');
  await page.click('.q-card:has-text("Maria Souza")'); await page.waitForSelector('.cartaoJ');
  await page.locator('.cartaoJ select').first().selectOption('orcamento');
  await page.waitForTimeout(500);
  await ctx.close();
  const r = reg.rpcs[0];
  return { ok: reg.rpcs.length === 1 && r.p_card === 1 && r.p_para === 'orcamento' && r.p_versao === 1, detalhe: JSON.stringify(reg.rpcs) };
});

await caso('Cartão de coluna do Klingo não tem para onde mover à mão', async () => {
  const { page, ctx } = await abrir();
  await page.click('.modo button:has-text("Quadro")'); await page.waitForSelector('.q-col');
  await page.click('.q-card:has-text("Ana Paula")'); await page.waitForSelector('.cartaoJ');
  const selects = await page.locator('.cartaoJ select').count();   // só o de responsável
  await ctx.close();
  return { ok: selects === 1, detalhe: `selects=${selects}` };
});

await caso('Voltar à Lista mostra a lista de conversas de novo', async () => {
  const { page, ctx } = await abrir();
  await page.click('.modo button:has-text("Quadro")'); await page.waitForSelector('.q-col');
  await page.click('#quadro .modo button:has-text("Lista")');
  const itens = await page.locator('.itens .item').count();
  await ctx.close();
  return { ok: itens >= 1, detalhe: `itens=${itens}` };
});

await caso('Banco sem a visão do quadro: avisa em português e a lista continua funcionando', async () => {
  const { page, ctx, reg } = await abrir({ quadroIndisponivel: true });
  await page.click('.modo button:has-text("Quadro")');
  await page.waitForSelector('text=ainda não está disponível', { timeout: 5000 });
  await page.click('#quadro .modo button:has-text("Lista")');
  const itens = await page.locator('.itens .item, .itens .vazio').count();
  await ctx.close();
  return { ok: itens >= 1 && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? 'ok' };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
