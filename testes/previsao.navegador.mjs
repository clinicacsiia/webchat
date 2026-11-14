// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com a lista de previsão) -> validação (botão "Lista de previsão" para quem atende; banco responde com erro) -> lógica (abre o quadro, mostra vaga em destaque, abre a conversa) -> saída (tabela na tela, sem executar HTML vindo do banco)
// Versão 2.0 — 14/11/2026 / Mudança: tela "Disponibilidade futura" (filtros por situação, precisa de pessoa, histórico). Versão 1.0 — 13/11/2026: lista de previsão
// Não substitui o teste com o Supabase real: a função do banco é simulada aqui (ela tem teste próprio em sql-pedido-sem-horario.test.mjs).
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
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const conversa = (id, nome, status, agente) => ({ id, status, agente_id: agente, ultima_mensagem: 'oi', nao_lidas_agente: 0, criado_em: agora, atualizado_em: agora, contato_id: 'ct-' + id, ia_ativa: false, motor: 'fluxo',
  triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null, contatos: { id: 'ct-' + id, nome, telefone: '71900000000', email: null } });
const h = (n) => new Date(Date.now() - n * 3600 * 1000).toISOString();
const com = (c, espera) => ({ ...c, cliente_aguarda_desde: espera });
const CONVERSAS = [
  conversa('c1', 'Maria Souza', 'aguardando', null),
  com(conversa('c2', 'João Lima', 'em_atendimento', EU.id), h(0.1)),
  com(conversa('c3', 'Ana Paula', 'em_atendimento', OUTRO.id), h(0.2)),
  com(conversa('c4', 'Pedro Alves', 'em_atendimento', OUTRO.id), h(2.5)),
  { ...conversa('c5', 'Lia Nunes', 'encerrada', OUTRO.id), encerrada_em: agora },
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

const ev = (tipo, origem = 'sistema') => ({ em: agora, tipo, origem });
const LISTA = { contagem: { oportunidade_identificada: 1, ativa: 2 }, itens: [
  { id: 's1', conversa_id: 'c1', paciente: 'Maria Souza', paciente_tipo: 'proprio', tipo: 'exame', procedimento: 'RM JOELHO', plano: 'Particular', turno: 'tarde', data_ini: '2026-11-13', data_fim: '2026-11-28', dias_semana: [1, 3, 5], estado: 'oportunidade_identificada',
    ultima_verificacao_em: agora, ultima_verificacao_resultado: 'ok_com_horarios', ultima_oportunidade: { data: '2026-11-20', hora: '14:00' }, notificacao: 'bloqueada_sem_autorizacao', precisa_humano: true, aceita_notificacao: false, canais: [], historico: [ev('criada', 'paciente'), ev('estado:oportunidade_identificada')], criado_em: agora, expira_em: agora },
  { id: 's2', conversa_id: 'c2', paciente: 'João <b>Lima</b>', paciente_tipo: 'filho', tipo: 'consulta', procedimento: 'CONSULTA', plano: 'Unimed', turno: 'manha', data_ini: '2026-11-13', data_fim: '2026-11-30', dias_semana: [2, 4], estado: 'ativa',
    ultima_verificacao_em: null, ultima_verificacao_resultado: null, ultima_oportunidade: null, notificacao: null, precisa_humano: false, aceita_notificacao: true, canais: ['chat'], historico: [ev('criada', 'paciente')], criado_em: agora, expira_em: agora },
  { id: 's3', conversa_id: 'c3', paciente: 'Ana Paula', paciente_tipo: 'proprio', tipo: 'exame', procedimento: 'US ABDOME', plano: 'Particular', turno: 'qualquer', data_ini: '2026-10-01', data_fim: '2026-10-20', dias_semana: [0, 1, 2, 3, 4, 5, 6], estado: 'expirada',
    ultima_verificacao_em: agora, ultima_verificacao_resultado: 'api_sem_horarios', ultima_oportunidade: null, notificacao: null, precisa_humano: false, aceita_notificacao: true, canais: ['chat'], historico: [], criado_em: agora, expira_em: agora }] };
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

async function pagina(browser, { nivel = 'supervisor', lista = LISTA, falha = false } = {}) {
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
    else if (p.startsWith('/rest/v1/jornada_coluna')) corpo = [];
    else if (p.startsWith('/rest/v1/jornada_transicao')) corpo = [];
    else if (p.startsWith('/rest/v1/v_jornada_quadro')) corpo = [];
    else if (p.endsWith('/rpc/org_nivel')) corpo = nivel;
    else if (p.endsWith('/rpc/painel_indicadores_atendentes')) { reg.rpcs.push(JSON.parse(req.postData() || '{}')); if (false) { status = 500; corpo = { message: 'falhou' }; } else corpo = { pessoas: [{ nome: 'Outra Pessoa', agendados: 3 }, { nome: 'Atendente de Teste', agendados: 1 }] }; }
    else if (p.endsWith('/rpc/painel_disponibilidade_lista')) { reg.rpcs.push('previsao'); if (falha) { status = 500; corpo = { message: 'falhou' }; } else corpo = lista; }
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
const linhas = (page) => page.$$eval('#tabPrevisao tbody tr', (trs) => trs.map((t) => ({ nome: t.querySelector('th').textContent, celulas: [...t.querySelectorAll('td')].map((c) => c.textContent), destaque: t.classList.contains('eq-livre') })));

await caso('Atendente vê o botão e a lista: vaga encontrada em destaque, "Precisa de pessoa" explicado, aviso de que NÃO é agendamento nem reserva', async () => {
  const { page, ctx, reg } = await abrir({ nivel: 'atendente' });
  await page.click('#btnPrevisao'); await page.waitForSelector('#tabPrevisao tbody tr');
  const l = await linhas(page); const titulo = await page.locator('dialog h3').first().textContent(); const dica = await page.locator('dialog .dica').first().textContent();
  await ctx.close();
  return { ok: l.length === 3 && l[0].nome === 'Maria Souza' && l[0].destaque && /Vaga encontrada/.test(l[0].celulas[2]) && /Precisa de pessoa: Sem autorização para avisar/.test(l[0].celulas[2]) && /Vaga: 20\/11\/2026 às 14:00/.test(l[0].celulas[4]) && /Tarde/.test(l[0].celulas[1]) && /Seg Qua Sex/.test(l[0].celulas[1])
    && /Procurando vaga/.test(l[1].celulas[2]) && !l[1].destaque && titulo === 'Disponibilidade futura' && /NÃO é agendamento nem reserva/.test(dica) && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? JSON.stringify(l.map((x) => x.celulas.slice(0, 3))) };
});
await caso('Filtros por situação (uma lista só): "Precisam de pessoa", "Expiradas" e "Procurando" mostram as linhas certas', async () => {
  const { page, ctx } = await abrir({ nivel: 'atendente' });
  await page.click('#btnPrevisao'); await page.waitForSelector('#tabPrevisao tbody tr');
  const n = async (rotulo) => { await page.click(`dialog .chip:has-text("${rotulo}")`); await espera(150); return (await page.locator('#tabPrevisao tbody tr').count()); };
  const humano = await n('Precisam de pessoa'), exp = await n('Expiradas'), proc = await n('Procurando');
  await ctx.close();
  return { ok: humano === 1 && exp === 1 && proc === 1, detalhe: `precisam de pessoa=${humano}; expiradas=${exp}; procurando=${proc}` };
});
await caso('Texto vindo do banco é mostrado como texto (nunca vira HTML)', async () => {
  const { page, ctx } = await abrir();
  await page.click('#btnPrevisao'); await page.waitForSelector('#tabPrevisao tbody tr');
  const nome = await page.locator('#tabPrevisao tbody tr:nth-child(2) th').textContent(); const tags = await page.locator('#tabPrevisao tbody tr:nth-child(2) b').count();
  await ctx.close();
  return { ok: nome.startsWith('João <b>Lima</b>') && tags === 1, detalhe: `nome=${nome} <b> na tabela=${tags}` };
});
await caso('Lista vazia mostra a mensagem; erro do banco mostra aviso e o painel continua funcionando', async () => {
  const a = await abrir({ lista: { contagem: {}, itens: [] } }); await a.page.click('#btnPrevisao'); await a.page.waitForSelector('dialog .dica:has-text("Nenhuma solicitação")'); await a.ctx.close();
  const b = await abrir({ falha: true }); await b.page.click('#btnPrevisao'); await b.page.waitForSelector('dialog [role=alert]');
  await b.page.click('dialog .rodape button'); const itens = await b.page.locator('.item').count(); const exc = b.reg.excecoes.length; await b.ctx.close();
  return { ok: itens > 0 && exc === 0, detalhe: `itens=${itens} exceções=${exc}` };
});
await caso('"Abrir conversa" fecha o quadro e abre a conversa da paciente', async () => {
  const { page, ctx } = await abrir();
  await page.click('#btnPrevisao'); await page.waitForSelector('#tabPrevisao tbody tr');
  await page.click('#tabPrevisao tbody tr:first-child button'); await espera(800);
  const aberto = await page.locator('dialog[open]').count(); const chat = await page.locator('#chat').textContent();
  await ctx.close();
  return { ok: aberto === 0 && /Maria Souza/.test(chat || ''), detalhe: `dialogs abertos=${aberto}` };
});
await caso('O botão "Equipe agora" da chefia continua funcionando junto', async () => {
  const { page, ctx } = await abrir({ nivel: 'gerente' });
  const a = await page.locator('#btnEquipe').count(), b = await page.locator('#btnPrevisao').count();
  await page.click('#btnEquipe'); await page.waitForSelector('#tabEquipe tbody tr'); await ctx.close();
  return { ok: a === 1 && b === 1 };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
