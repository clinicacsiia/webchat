// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com conversas de vários atendentes) -> validação (linha principal com 4 filtros; "Abertas" abre a 2ª linha com quem conduz; filtro lembrado só no mesmo dia) -> lógica (cliques nos chips, recarga da página, data antiga no armazenamento) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 19/11/2026 / Mudança: Implementação inicial (filtros do painel em dois níveis, opções A + D)
//
// Não substitui o teste com o Supabase real: as funções do banco são simuladas aqui.
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
const h = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString();
const com = (c, espera) => ({ ...c, cliente_aguarda_desde: espera });
const CONVERSAS = [
  conversa('c1', 'Maria Souza', 'aguardando', null),
  com(conversa('c2', 'João Lima', 'em_atendimento', EU.id), h(0.1)),
  com(conversa('c3', 'Ana Paula', 'em_atendimento', OUTRO.id), h(0.2)),
  com(conversa('c4', 'Pedro Alves', 'em_atendimento', OUTRO.id), h(2.5)),
  conversa('c5', 'Lia Nunes', 'encerrada', OUTRO.id),
  // Equipe já respondeu e o paciente demora (aguarda_paciente_desde): vão para o grupo "Aguardando resposta do paciente", da mais antiga (c8, 9 h) para a mais nova (c7, 1 h).
  { ...conversa('c6', 'Rita Dias', 'em_atendimento', OUTRO.id), cliente_aguarda_desde: null, aguarda_paciente_desde: h(5) },
  { ...conversa('c7', 'Zé Costa', 'em_atendimento', EU.id), cliente_aguarda_desde: null, aguarda_paciente_desde: h(1) },
  { ...conversa('c8', 'Bia Sol', 'em_atendimento', OUTRO.id), cliente_aguarda_desde: null, aguarda_paciente_desde: h(9) },
  // Paciente esperando a equipe há 30 min (mais antigo que a Ana Paula, 12 min): deve vir antes dela no grupo do atendente.
  com(conversa('c9', 'Caio Reis', 'em_atendimento', OUTRO.id), h(0.5)),
];
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

const grupos = (page) => page.locator('.grupo-cab').evaluateAll((l) => l.map((b) => b.querySelector('.gnome').textContent + ':' + b.querySelector('.gn').textContent));


const abrir = async () => { const t = await pagina(browser); await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('.modo', { timeout: 10000 }); return t; };
const rotulos = (page, seletor) => page.locator(seletor).evaluateAll((l) => l.map((b) => b.getAttribute('data-filtro') + ':' + (b.getAttribute('aria-pressed') === 'true' ? 'on' : 'off')));

await caso('abre em "Aguardando", com só 4 filtros na linha principal e sem a segunda linha', async () => {
  const { page, ctx, reg } = await abrir();
  const principais = await rotulos(page, '#filtros > .chip[data-filtro]');
  const sub = await page.locator('#filtrosSub').count();
  await ctx.close();
  return { ok: principais.join() === 'aguardando:on,meus:off,abertas:off,encerradas:off' && sub === 0 && !reg.excecoes.length, detalhe: principais.join() + ` sub=${sub} ` + (reg.excecoes[0] ?? '') };
});

await caso('tocar em "Abertas" abre a segunda linha (Todas, Com o assistente, Agendado pela API, Com atendente) e a lista continua agrupada', async () => {
  const { page, ctx } = await abrir();
  await page.click('#filtros > .chip[data-filtro=abertas]');
  const principal = await rotulos(page, '#filtros > .chip[data-filtro]');
  const sub = await rotulos(page, '#filtrosSub .chip');
  const grupos = await page.locator('.grupo-cab').count();
  await ctx.close();
  return { ok: principal.join() === 'aguardando:off,meus:off,abertas:on,encerradas:off' && sub.join() === 'abertas:on,assistente:off,agendado_api:off,com_atendente:off' && grupos > 0, detalhe: `${principal} | ${sub} | grupos=${grupos}` };
});

await caso('escolher "Com atendente" mantém "Abertas" aceso, marca a opção e só lista as conversas dela (sem agrupar)', async () => {
  const { page, ctx } = await abrir();
  await page.click('#filtros > .chip[data-filtro=abertas]');
  const n = Number((await page.locator('#filtrosSub .chip[data-filtro=com_atendente]').innerText()).match(/\((\d+)\)/)[1]);
  await page.click('#filtrosSub .chip[data-filtro=com_atendente]');
  const principal = await rotulos(page, '#filtros > .chip[data-filtro]');
  const sub = await rotulos(page, '#filtrosSub .chip');
  const itens = await page.locator('.item').count(), grupos = await page.locator('.grupo-cab').count();
  await ctx.close();
  return { ok: principal[2] === 'abertas:on' && sub[3] === 'com_atendente:on' && sub[0] === 'abertas:off' && itens === n && grupos === 0 && n > 0, detalhe: `${principal} | ${sub} | itens=${itens} esperado=${n} grupos=${grupos}` };
});

await caso('"Encerradas" e "Meus" não mostram a segunda linha', async () => {
  const { page, ctx } = await abrir();
  await page.click('#filtros > .chip[data-filtro=encerradas]'); const a = await page.locator('#filtrosSub').count();
  await page.click('#filtros > .chip[data-filtro=meus]'); const b = await page.locator('#filtrosSub').count();
  await ctx.close();
  return { ok: a === 0 && b === 0, detalhe: `encerradas=${a}, meus=${b}` };
});

await caso('o filtro escolhido é lembrado ao recarregar no mesmo dia (inclusive a opção da segunda linha)', async () => {
  const { page, ctx } = await abrir();
  await page.click('#filtros > .chip[data-filtro=abertas]'); await page.click('#filtrosSub .chip[data-filtro=assistente]');
  await page.reload(); await page.waitForSelector('.modo', { timeout: 10000 });
  const principal = await rotulos(page, '#filtros > .chip[data-filtro]'); const sub = await rotulos(page, '#filtrosSub .chip');
  await ctx.close();
  return { ok: principal[2] === 'abertas:on' && sub[1] === 'assistente:on', detalhe: `${principal} | ${sub}` };
});

await caso('em outro dia, ou com valor inválido guardado, o painel volta a abrir em "Aguardando"', async () => {
  const { page, ctx, reg } = await abrir();
  const abreEm = async (valor) => { await page.evaluate((v) => localStorage.setItem('painel.filtro', v), valor); await page.reload(); await page.waitForSelector('.modo', { timeout: 10000 }); return (await rotulos(page, '#filtros > .chip[data-filtro]')).join(); };
  const antigo = await abreEm(JSON.stringify({ dia: '2000-01-01', filtro: 'encerradas' }));
  const invalido = await abreEm(JSON.stringify({ dia: new Date().toLocaleDateString('sv-SE'), filtro: 'inexistente' }));
  const lixo = await abreEm('isto não é json');
  await ctx.close();
  const esperado = 'aguardando:on,meus:off,abertas:off,encerradas:off';
  return { ok: antigo === esperado && invalido === esperado && lixo === esperado && !reg.excecoes.length, detalhe: `${antigo} | ${invalido} | ${lixo} ${reg.excecoes[0] ?? ''}` };
});

await caso('"Transferir em lote" continua na tela, discreto, e abre a janela de transferência', async () => {
  const { page, ctx } = await abrir();
  const b = page.locator('#btnLote'); const discreto = await b.evaluate((e) => e.classList.contains('discreto'));
  await b.click(); await page.waitForSelector('dialog[open], #dlg[open], dialog', { state: 'attached', timeout: 5000 });
  const texto = await page.locator('dialog').first().innerText().catch(() => '');
  await ctx.close();
  return { ok: discreto && /Transferir em lote/.test(texto), detalhe: texto.slice(0, 60).replace(/\n/g, ' ') };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
