// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com cartões de conversa e do Klingo, avisos de atraso e o estado do monitor) -> validação (a aba Jornada existe, pede todos os cartões e não só os de conversa) -> lógica (colunas, painel "Precisam de atenção", selo, estado do monitor, filtros, detalhe do paciente, assumir, marcar tarefa, mover, abrir conversa, banco fora do ar) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
//
// Não substitui o teste com o Supabase real: as funções do banco são simuladas aqui (o banco foi conferido à parte, em 01/11/2026).
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
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': 'content-range' };
const agora = Date.now();
const minAtras = (m) => new Date(agora - m * 60000).toISOString();
const daqui = (m) => new Date(agora + m * 60000).toISOString();

const conversa = (id, nome, status, agente) => ({ id, status, agente_id: agente, ultima_mensagem: 'oi', nao_lidas_agente: 0, criado_em: minAtras(5), atualizado_em: minAtras(5), contato_id: 'ct-' + id, ia_ativa: false, motor: 'fluxo',
  triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null, contatos: { id: 'ct-' + id, nome, telefone: '71900000000', email: null } });
const CONVERSAS = [conversa('c1', 'Maria Souza', 'aguardando', null)];
const COLUNAS = [['contato', 'Em conversa no chat', 1, 'manual', 'antes'], ['orcamento', 'Pedido pronto', 2, 'manual', 'antes'], ['a_confirmar', 'A confirmar', 5, 'klingo', 'agendamento'], ['confirmado', 'Confirmado', 6, 'klingo', 'agendamento'],
  ['chegou', 'Chegou', 7, 'manual', 'depois'], ['em_atendimento', 'Em atendimento', 8, 'klingo', 'depois'], ['finalizado', 'Finalizado', 9, 'manual', 'depois'], ['laudo_pendente', 'Laudo pendente', 10, 'manual', 'pos'], ['faltou', 'Faltou', 22, 'klingo', 'excecao']]
  .map(([id, nome, ordem, origem, etapa]) => ({ id, nome, ordem, origem, etapa, sla_min: null }));
const TRANS = [['confirmado', 'chegou'], ['chegou', 'finalizado'], ['finalizado', 'laudo_pendente'], ['contato', 'orcamento']].map(([de, para]) => ({ de, para }));
const card = (id, nome, coluna, extra = {}) => ({ id, paciente_nome: nome, coluna, coluna_nome: COLUNAS.find((c) => c.id === coluna).nome, etapa: 'depois', origem: 'klingo', ordem: 1, data_ref: '2026-11-02', unidade: 'CSI 1',
  coluna_desde: minAtras(10), responsavel: null, prioridade: 0, versao: 1, conversa_id: null, primeiro_exame: 'Ultrassom de abdome', n_ativos: 1, atrasado: false, n_tarefas_abertas: 0, n_tarefas_vencidas: 0, proxima_hora: daqui(30), ...extra });
const CARTOES = [
  card(1, 'Maria Souza', 'contato', { conversa_id: 'c1', primeiro_exame: 'Ressonância de joelho' }),
  card(2, 'Carlos Klingo', 'confirmado', { proxima_hora: minAtras(25), coluna_desde: minAtras(400), n_tarefas_abertas: 1, n_tarefas_vencidas: 1 }),   // passou do horário
  card(3, 'Bia Chegou', 'chegou', { responsavel: EU.id, coluna_desde: minAtras(50), atrasado: true, n_tarefas_abertas: 1, n_tarefas_vencidas: 1, prioridade: 2 }),
  card(4, 'Davi Atendido', 'em_atendimento', { responsavel: OUTRO.id, coluna_desde: minAtras(20) }),
  card(5, 'Elaine Unidade2', 'a_confirmar', { unidade: 'CSI 2' })];
const EXAMES = [{ id: 1, procedimento: 'Ultrassom de abdome', operadora: 'UNIMED', agendado_para: minAtras(25), status: 'confirmado', confirm_status: 'C' }];
const TAREFAS = [{ id: 77, titulo: 'Passou do horário e o paciente ainda não foi atendido: localizar', vence_em: minAtras(1), feita_em: null, criada_em: minAtras(1) }];
const EVENTOS = [{ id: 9, quando: minAtras(1), tipo: 'tarefa', origem: 'sistema', usuario: null, de_coluna: null, para_coluna: null, detalhe: { acao: 'alerta', motivo: 'horario' } },
  { id: 8, quando: minAtras(400), tipo: 'movido', origem: 'klingo', usuario: null, de_coluna: 'a_confirmar', para_coluna: 'confirmado', detalhe: {} }];

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

// estado: 'ok' | 'parado' (o monitor não roda há 20 min) | 'klingo_erro'. bancoFora: a visão não responde.
async function pagina(browser, { estado = 'ok', bancoFora = false } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
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
    reg.pedidos.push(`${req.method()} ${p}${url.search}`);
    let corpo; let status = 200; const headers = { ...CORS };
    if (p.startsWith('/auth/v1/user')) corpo = { id: EU.id, aud: 'authenticated', role: 'authenticated', email: EU.email };
    else if (p.startsWith('/rest/v1/agentes')) corpo = url.searchParams.get('id') ? (objeto ? EU : [EU]) : [EU, OUTRO];
    else if (p.startsWith('/rest/v1/conversas')) corpo = CONVERSAS;
    else if (p.startsWith('/rest/v1/jornada_coluna')) corpo = COLUNAS;
    else if (p.startsWith('/rest/v1/jornada_transicao')) corpo = TRANS;
    else if (p.startsWith('/rest/v1/jornada_exame')) corpo = EXAMES;
    else if (p.startsWith('/rest/v1/jornada_tarefa')) corpo = TAREFAS;
    else if (p.startsWith('/rest/v1/jornada_evento')) corpo = EVENTOS;
    else if (p.startsWith('/rest/v1/jornada_sync_estado')) {
      const e = { klingo_em: minAtras(1), klingo_erro: null, klingo_falhas: 0, vigia_em: minAtras(0.2), vigia_erro: null };
      if (estado === 'parado') { e.vigia_em = minAtras(20); e.klingo_em = minAtras(20); }
      if (estado === 'klingo_erro') { e.klingo_erro = 'Klingo retornou HTTP 502 nas marcações'; e.klingo_falhas = 3; }
      corpo = objeto ? e : [e];
    }
    else if (p.startsWith('/rest/v1/v_jornada_quadro')) {
      if (bancoFora) { status = 404; corpo = { message: 'relation "v_jornada_quadro" does not exist' }; }
      else if (req.method() === 'HEAD') { const n = CARTOES.filter((k) => k.n_tarefas_vencidas > 0).length; headers['content-range'] = `0-${n - 1}/${n}`; status = 200; return rota.fulfill({ status, headers, body: '' }); }
      else corpo = CARTOES;
    }
    else if (p.startsWith('/rest/v1/rpc/')) { reg.rpcs.push({ rpc: p.split('/').pop(), ...JSON.parse(req.postData() || '{}') }); corpo = { ok: true, versao: 2 }; }
    else if (p.startsWith('/rest/v1/')) corpo = objeto ? null : [];
    else corpo = {};
    return rota.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(corpo) });
  });
  if (typeof page.routeWebSocket === 'function') await page.routeWebSocket(/supabase\.co/, (ws) => ws.close());
  return { page, ctx, reg };
}

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + e.message.split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const abrir = async (opcoes) => { const t = await pagina(browser, opcoes); await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('nav.nav', { timeout: 10000 }); await t.page.click('nav.nav button[data-aba=jornada]'); await t.page.waitForSelector('#jornada', { timeout: 5000 }); return t; };
const nomesNaColuna = (page, col) => page.locator(`.q-col[data-coluna="${col}"] .q-card b`).allInnerTexts();

await caso('a aba Jornada vem logo depois de Atendimento, com o selo de avisos', async () => {
  const { page, ctx, reg } = await abrir();
  await page.waitForFunction(() => { const s = document.getElementById('seloJornada'); return s && !s.hidden; }, null, { timeout: 5000 });
  const abas = await page.locator('nav.nav button').evaluateAll((b) => b.map((x) => x.dataset.aba));
  const selo = await page.locator('#seloJornada').innerText();
  await ctx.close();
  return { ok: abas[0] === 'atendimento' && abas[1] === 'jornada' && selo === '2' && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? `${abas.join(',')} selo=${selo}` };
});

await caso('mostra todos os pacientes (inclusive os do Klingo sem conversa) e não filtra por conversa', async () => {
  const { page, ctx, reg } = await abrir();
  await page.waitForSelector('.q-card');
  const pedido = reg.pedidos.find((p) => p.includes('GET') && p.includes('v_jornada_quadro') && p.includes('select=id%2Cpaciente_nome')) ?? '';
  const total = await page.locator('.q-card').count();
  await ctx.close();
  return { ok: total === 5 && !/conversa_id=not\.is\.null/.test(pedido) && /data_ref\.eq\.\d{4}-\d{2}-\d{2}/.test(decodeURIComponent(pedido)) && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? `cartões=${total}; pedido=${decodeURIComponent(pedido).slice(0, 160)}` };
});

await caso('cada paciente aparece na coluna certa; o fluxo normal aparece mesmo vazio e as exceções só com cartão', async () => {
  const { page, ctx } = await abrir();
  await page.waitForSelector('.q-card');
  const c = {}; for (const id of ['contato', 'confirmado', 'chegou', 'em_atendimento', 'a_confirmar']) c[id] = (await nomesNaColuna(page, id)).join();
  const colunas = await page.locator('.q-col').evaluateAll((e) => e.map((x) => x.dataset.coluna));
  await ctx.close();
  const ok = c.contato === 'Maria Souza' && c.confirmado === 'Carlos Klingo' && c.chegou === 'Bia Chegou' && c.em_atendimento === 'Davi Atendido' && c.a_confirmar === 'Elaine Unidade2'
    && colunas.includes('finalizado') && !colunas.includes('laudo_pendente') && !colunas.includes('faltou');
  return { ok, detalhe: JSON.stringify(c) + ' colunas=' + colunas.join() };
});

await caso('"Precisam de atenção agora" lista quem tem aviso vencido, do que espera há mais tempo', async () => {
  const { page, ctx } = await abrir();
  await page.waitForSelector('.j-atencao');
  const titulo = await page.locator('.j-atencao h3').innerText();
  const nomes = await page.locator('.j-aviso .quem b').allInnerTexts();
  const botoes = await page.locator('.j-aviso').first().locator('.btn').allInnerTexts();
  await ctx.close();
  return { ok: /\(2\)/.test(titulo) && nomes.join() === 'Carlos Klingo,Bia Chegou' && botoes.includes('Assumir') && botoes.includes('Resolver'), detalhe: `${titulo}|${nomes}|${botoes}` };
});

await caso('estado do monitor: normal, monitoramento parado e Klingo fora do ar', async () => {
  const lerEstado = async (estado) => { const { page, ctx } = await abrir({ estado }); await page.waitForSelector('.j-status'); await page.waitForTimeout(250); const r = [await page.locator('.j-status').getAttribute('class'), await page.locator('.j-status').innerText()]; await ctx.close(); return r; };
  const [okC, okT] = await lerEstado('ok'), [pC, pT] = await lerEstado('parado'), [kC, kT] = await lerEstado('klingo_erro');
  return { ok: /\bok\b/.test(okC) && /Monitorando/.test(okT) && /ruim/.test(pC) && /monitoramento parou/.test(pT) && /ruim/.test(kC) && /Klingo não respondeu/.test(kT), detalhe: `${okT.replace(/\n/g, ' ')}|${pT.replace(/\n/g, ' ')}|${kT.replace(/\n/g, ' ')}` };
});

await caso('filtros Meus, Sem responsável e Com aviso e a busca', async () => {
  const { page, ctx } = await abrir();
  await page.waitForSelector('.q-card');
  const todos = async () => (await page.locator('.q-colunas .q-card b').allInnerTexts()).sort().join(',');
  await page.click('.q-topo .chip:has-text("Meus")'); const meus = await todos();
  await page.click('.q-topo .chip:has-text("Sem responsável")'); const livres = await todos();
  await page.click('.q-topo .chip:has-text("Com aviso")'); const aviso = await todos();
  await page.click('.q-topo .chip:has-text("Todos")');
  await page.fill('#jornada input[type=search]', 'davi'); await page.waitForTimeout(450); const busca = await todos();
  await ctx.close();
  return { ok: meus === 'Bia Chegou' && livres === 'Carlos Klingo,Elaine Unidade2,Maria Souza' && aviso === 'Bia Chegou,Carlos Klingo' && busca === 'Davi Atendido', detalhe: `${meus}|${livres}|${aviso}|${busca}` };
});

await caso('filtro por unidade aparece quando há mais de uma', async () => {
  const { page, ctx } = await abrir();
  await page.waitForSelector('.q-card');
  await page.locator('.q-topo select[aria-label=Unidade]').selectOption('CSI 2');
  const nomes = (await page.locator('.q-colunas .q-card b').allInnerTexts()).join();
  await ctx.close();
  return { ok: nomes === 'Elaine Unidade2', detalhe: nomes };
});

await caso('trocar o período pede de novo ao banco (Próximos 30 dias não filtra por data)', async () => {
  const { page, ctx, reg } = await abrir();
  await page.waitForSelector('.q-card');
  const antes = reg.pedidos.length;
  await page.click('.q-topo .chip:has-text("Próximos 30 dias")');
  await page.waitForTimeout(600);
  const novos = reg.pedidos.slice(antes).filter((p) => p.startsWith('GET') && p.includes('v_jornada_quadro') && p.includes('select=id%2Cpaciente_nome'));
  await ctx.close();
  return { ok: novos.length >= 1 && !/data_ref\.(eq|gte|lte)/.test(decodeURIComponent(novos[0])), detalhe: novos.map((p) => decodeURIComponent(p).slice(-90)).join(' || ') };
});

await caso('abrir o paciente mostra exames, aviso, histórico, e registra o acesso', async () => {
  const { page, ctx, reg } = await abrir();
  await page.waitForSelector('.q-card');
  await page.click('.q-card:has-text("Carlos Klingo")');
  await page.waitForSelector('dialog[open] .j-sec', { timeout: 5000 });
  const texto = await page.locator('dialog[open]').innerText();
  await ctx.close();
  const acesso = reg.rpcs.find((r) => r.rpc === 'jornada_registrar_acesso');
  return { ok: /Ultrassom de abdome/.test(texto) && /Passou do horário/.test(texto) && /A confirmar → Confirmado/.test(texto) && /aviso aberto/.test(texto) && acesso && acesso.p_card === 2, detalhe: texto.replace(/\n+/g, ' | ').slice(0, 220) };
});

await caso('Assumir chama jornada_atribuir_card com o usuário e a versão do cartão', async () => {
  const { page, ctx, reg } = await abrir();
  await page.waitForSelector('.j-aviso');
  await page.locator('.j-aviso:has-text("Carlos Klingo") button:has-text("Assumir")').click();
  await page.waitForTimeout(500);
  await ctx.close();
  const r = reg.rpcs.find((x) => x.rpc === 'jornada_atribuir_card');
  return { ok: !!r && r.p_card === 2 && r.p_responsavel === EU.id && r.p_versao === 1, detalhe: JSON.stringify(r) };
});

await caso('marcar a tarefa como feita chama jornada_marcar_tarefa', async () => {
  const { page, ctx, reg } = await abrir();
  await page.waitForSelector('.q-card');
  await page.click('.q-card:has-text("Carlos Klingo")');
  await page.waitForSelector('dialog[open] .j-sec');
  await page.locator('dialog[open] li:has-text("Passou do horário") button:has-text("Feita")').click();
  await page.waitForTimeout(500);
  await ctx.close();
  const r = reg.rpcs.find((x) => x.rpc === 'jornada_marcar_tarefa');
  return { ok: !!r && r.p_tarefa === 77 && r.p_feita === true, detalhe: JSON.stringify(r) };
});

await caso('mover pelo detalhe só oferece colunas permitidas e chama jornada_mover_card', async () => {
  const { page, ctx, reg } = await abrir();
  await page.waitForSelector('.q-card');
  await page.click('.q-card:has-text("Bia Chegou")'); await page.waitForSelector('dialog[open] .j-acoes');
  const opcoes = await page.locator('dialog[open] .j-acoes select').first().locator('option').allInnerTexts();
  await page.locator('dialog[open] .j-acoes select').first().selectOption('finalizado');
  await page.waitForTimeout(500);
  await ctx.close();
  const r = reg.rpcs.find((x) => x.rpc === 'jornada_mover_card');
  return { ok: opcoes.join() === 'Mover para…,Finalizado' && !!r && r.p_card === 3 && r.p_para === 'finalizado' && r.p_versao === 1, detalhe: `${opcoes}|${JSON.stringify(r)}` };
});

await caso('paciente do Klingo não tem "Abrir conversa"; o do chat tem e leva ao Atendimento', async () => {
  const { page, ctx } = await abrir();
  await page.waitForSelector('.q-card');
  await page.click('.q-card:has-text("Carlos Klingo")'); await page.waitForSelector('dialog[open] .j-sec');
  const semChat = await page.locator('dialog[open] button:has-text("Abrir conversa")').count();
  await page.click('dialog[open] button:has-text("Fechar")');
  await page.click('.q-card:has-text("Maria Souza")'); await page.waitForSelector('dialog[open] .j-sec');
  await page.click('dialog[open] button:has-text("Abrir conversa")');
  await page.waitForSelector('#chatTopo', { timeout: 5000 });
  const aba = await page.locator('nav.nav button[aria-current=page]').getAttribute('data-aba');
  await ctx.close();
  return { ok: semChat === 0 && aba === 'atendimento', detalhe: `semChat=${semChat} aba=${aba}` };
});

await caso('na aba, pede ao banco para ler o Klingo (jornada_acordar)', async () => {
  const { page, ctx, reg } = await abrir();
  await page.waitForSelector('.q-card'); await page.waitForTimeout(300);
  await ctx.close();
  return { ok: reg.rpcs.some((r) => r.rpc === 'jornada_acordar'), detalhe: reg.rpcs.map((r) => r.rpc).join() };
});

await caso('banco fora do ar: avisa em português, com "Tentar de novo", sem quebrar', async () => {
  const { page, ctx, reg } = await abrir({ bancoFora: true });
  await page.waitForSelector('text=A Jornada não carregou', { timeout: 5000 });
  const botao = await page.locator('#jornada button:has-text("Tentar de novo")').count();
  await ctx.close();
  return { ok: botao === 1 && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? 'ok' };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
