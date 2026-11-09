// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com conversas de hoje, duas delas da mesma pessoa) -> validação (cartões do topo e aba Indicadores) -> lógica (pessoas juntam conversas; média = conversas ÷ pessoas; filtro de unidade vale nos dois lugares; sem o SQL novo cai no resumo antigo) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial
//
// Não substitui o teste com o Supabase real: as funções do banco são simuladas aqui. A conta do banco (supabase/indicadores-unidade.sql) foi conferida ao vivo contra a consulta direta.
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
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const agora = new Date().toISOString();
const conversa = (id, nome, status, unidade) => ({ id, status, agente_id: null, ultima_mensagem: 'oi', nao_lidas_agente: 0, criado_em: agora, atualizado_em: agora, contato_id: 'ct-' + id, ia_ativa: false, motor: 'fluxo',
  triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null, unidade_inicial: unidade, cliente_aguarda_desde: null, aguarda_paciente_desde: null,
  contatos: { id: 'ct-' + id, nome, telefone: '7190000' + id.slice(1), email: null } });
// c1 e c2 são a mesma pessoa; c4 é da CSI; c5 já foi encerrada.
const CONVERSAS = [conversa('c1', 'Maria Souza', 'aguardando', 'desenvoar'), conversa('c2', 'Maria Souza', 'em_atendimento', 'desenvoar'), conversa('c3', 'Ana Paula', 'em_atendimento', 'desenvoar'),
  conversa('c4', 'Pedro Alves', 'em_atendimento', 'csi'), conversa('c5', 'Lia Nunes', 'encerrada', 'desenvoar')];
// c3 (Desenvoar): a equipe respondeu e o paciente não voltou -> conta. c4 (CSI): também respondida, mas o paciente já mandou outra mensagem sem resposta -> NÃO conta.
const antes = new Date(Date.now() - 3600e3).toISOString();
CONVERSAS[2].aguarda_paciente_desde = antes; CONVERSAS[3].aguarda_paciente_desde = antes; CONVERSAS[3].cliente_aguarda_desde = antes;
const GRUPOS = [{ conversa_id: 'c1', grupo_id: 'g1', sinais: ['nome'], origem: 'auto', confirmado_por: null }, { conversa_id: 'c2', grupo_id: 'g1', sinais: ['nome'], origem: 'auto', confirmado_por: null }];
const RESUMO = (total, pessoas, media, fin) => ({ periodo_dias: 1, unidade: null, desde: agora, gerado_em: agora,
  conversas: { total, pessoas, finalizadas: fin, em_andamento: total - fin, media_por_pessoa: media },
  pedidos: { conversas_com_pedido_completo: 2, agendados: 1, agendados_pela_ia: 1, agendados_pela_equipe: 0, prontos_esperando_recepcao: 1, cancelados: 0, rascunhos: 0 },
  por_dia: [{ dia: '2026-11-09', conversas: total, pessoas, finalizadas: fin, media_por_pessoa: media, pedidos_completos: 2, agendados: 1 }],
  por_hora: [{ hora: 9, conversas: 2 }, { hora: 10, conversas: total - 2 }],
  encerramentos: { total: 1, automaticos: 0, por_motivo: { agendado: 1 } }, avaliacoes: null });
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

async function pagina(browser, { semSqlNovo = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });   // cartões do topo somem em telas baixas (<= 820 px)
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.unidade'); } catch {}
  }, [EU.id, jwt(EU.id), EU.email]);
  const reg = { excecoes: [], rpcs: [] };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => reg.excecoes.push(e.message));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: require('node:fs').readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url()); const p = url.pathname;
    const objeto = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    let corpo; let status = 200;
    if (p.startsWith('/auth/v1/user')) corpo = { id: EU.id, aud: 'authenticated', role: 'authenticated', email: EU.email };
    else if (p.startsWith('/rest/v1/agentes')) corpo = url.searchParams.get('id') ? (objeto ? EU : [EU]) : [EU];
    else if (p.startsWith('/rest/v1/conversas')) corpo = CONVERSAS;
    else if (p.startsWith('/rest/v1/conversa_grupo')) corpo = GRUPOS;
    else if (p.endsWith('/rpc/painel_indicadores_unidade')) {
      const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['unidade', b]);
      if (semSqlNovo) { status = 404; corpo = { code: 'PGRST202', message: 'Could not find the function public.painel_indicadores_unidade(p_dias, p_unidade) in the schema cache' }; }
      else corpo = b.p_unidade === 'desenvoar' ? RESUMO(4, 3, 1.33, 1) : RESUMO(5, 4, 1.25, 1);
    }
    else if (p.endsWith('/rpc/painel_indicadores')) { reg.rpcs.push(['antiga', JSON.parse(req.postData() || '{}')]); corpo = { ...RESUMO(5, 4, null, 1), pessoas: undefined, encerramentos: undefined }; }
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
const abrir = async (opc) => { const t = await pagina(browser, opc); await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('#kpis .kpi', { timeout: 10000 }); return t; };
const cartoes = (page) => page.locator('#kpis .kpi').evaluateAll((l) => Object.fromEntries(l.map((k) => [k.querySelector('small').textContent, k.querySelector('strong').textContent])));
const esperaCartao = (page, rot, v) => page.waitForFunction(([r, x]) => [...document.querySelectorAll('#kpis .kpi')].some((k) => k.querySelector('small').textContent === r && k.querySelector('strong').textContent === x), [rot, v], { timeout: 5000 });

await caso('Cartões do topo (todas as unidades): 5 conversas, 4 pessoas, média 1,25 e 1 encerrada', async () => {
  const { page, ctx, reg } = await abrir(); await esperaCartao(page, 'Pessoas hoje', '4');
  const k = await cartoes(page);
  if (process.env.FOTO) await page.screenshot({ path: process.env.FOTO + '/topo.png', clip: { x: 256, y: 0, width: 1184, height: 190 } });
  await ctx.close();
  return { ok: k['Conversas hoje'] === '5' && k['Pessoas hoje'] === '4' && k['Conversas por pessoa'] === '1,25' && k['Encerradas hoje'] === '1' && !reg.excecoes.length, detalhe: JSON.stringify(k) + (reg.excecoes[0] ?? '') };
});

await caso('Quadrado "Aguardando paciente": conta quem a equipe já respondeu e não voltou (1), e o filtro de unidade vale', async () => {
  const { page, ctx, reg } = await abrir(); await esperaCartao(page, 'Aguardando paciente', '1');
  const todas = await cartoes(page);
  await page.selectOption('#selUnidade', 'csi'); await esperaCartao(page, 'Aguardando paciente', '0');
  await page.selectOption('#selUnidade', 'desenvoar'); await esperaCartao(page, 'Aguardando paciente', '1');
  if (process.env.FOTO) await page.screenshot({ path: process.env.FOTO + '/topo-aguardando.png', clip: { x: 256, y: 0, width: 1184, height: 190 } });
  await ctx.close();
  return { ok: todas['Aguardando paciente'] === '1' && todas['Em espera'] === '1' && !reg.excecoes.length, detalhe: JSON.stringify(todas) + (reg.excecoes[0] ?? '') };
});

await caso('Filtro de unidade Desenvoar vale para os cartões: some a conversa da CSI (4 conversas, 3 pessoas, média 1,33)', async () => {
  const { page, ctx } = await abrir(); await esperaCartao(page, 'Pessoas hoje', '4');
  await page.selectOption('#selUnidade', 'desenvoar'); await esperaCartao(page, 'Pessoas hoje', '3');
  const k = await cartoes(page); await ctx.close();
  return { ok: k['Conversas hoje'] === '4' && k['Conversas por pessoa'] === '1,33' && k['Encerradas hoje'] === '1', detalhe: JSON.stringify(k) };
});

await caso('Aba Indicadores: pede o resumo com a unidade do topo (nulo, depois desenvoar) e mostra pessoas e média', async () => {
  const { page, ctx, reg } = await abrir(); await esperaCartao(page, 'Pessoas hoje', '4');
  await page.click('.nav button[data-aba=indicadores]'); await page.waitForSelector('.numeros .num');
  const todas = (await page.locator('.numeros').first().innerText()).replace(/\n+/g, ' ');
  if (process.env.FOTO) { await page.screenshot({ path: process.env.FOTO + '/indicadores.png', fullPage: true }); }
  await page.selectOption('#selUnidade', 'desenvoar'); await page.waitForFunction(() => /Unidade Desenvoar/.test(document.querySelector('.pagina')?.innerText || ''));
  const des = (await page.locator('.numeros').first().innerText()).replace(/\n+/g, ' ');
  const unidades = reg.rpcs.filter((r) => r[0] === 'unidade').map((r) => r[1].p_unidade);
  const tabela = await page.locator('thead th').allInnerTexts();
  await ctx.close();
  return { ok: unidades[0] === null && unidades.at(-1) === 'desenvoar' && /5 conversas iniciadas/.test(todas) && /4 pessoas diferentes/.test(todas) && /1,25 conversas por pessoa/.test(todas) && /4 conversas iniciadas/.test(des) && /1,33/.test(des)
    && tabela.includes('Pessoas') && tabela.includes('Conversas por pessoa') && !reg.excecoes.length, detalhe: `${unidades} | ${todas} | ${des} | ${tabela}` };
});

await caso('Período padrão é Hoje (p_dias = 1) e o gráfico por horário aparece', async () => {
  const { page, ctx, reg } = await abrir(); await esperaCartao(page, 'Pessoas hoje', '4');
  await page.click('.nav button[data-aba=indicadores]'); await page.waitForSelector('.barras-h .bh');
  const dias = reg.rpcs[0][1].p_dias, barras = await page.locator('.barras-h .bh').count(), sel = await page.locator('.pagina select').inputValue();
  await ctx.close();
  return { ok: dias === 1 && barras === 2 && sel === '1', detalhe: `p_dias=${dias} barras=${barras} select=${sel}` };
});

await caso('Sem o SQL novo no banco, Indicadores cai para o resumo antigo e avisa que é a clínica toda', async () => {
  const { page, ctx, reg } = await abrir({ semSqlNovo: true }); await esperaCartao(page, 'Pessoas hoje', '4');
  await page.click('.nav button[data-aba=indicadores]'); await page.waitForSelector('.numeros .num');
  const txt = await page.locator('.pagina').first().innerText();
  await ctx.close();
  return { ok: reg.rpcs.some((r) => r[0] === 'antiga') && /Clínica toda/.test(txt) && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? '' };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
