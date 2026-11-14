// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado; a equipe é ADMIN) -> validação (a tela "Disponibilidade futura", as chaves do autoatendimento nas Configurações e os números do pós-agendamento nos Indicadores)
//   -> lógica (cada situação aparece no filtro certo; cancelar a procura chama a função certa; salvar uma chave grava só a chave alterada) -> saída (PASS/FAIL)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão (painel v25). Dados inventados; nada toca o Supabase nem o Klingo reais.
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

const DISP = { contagem: { ativa: 1, oportunidade_identificada: 1, notificada: 0, expirada: 1 }, itens: [
  { id: 's1', conversa_id: 'c1', paciente: 'Maria Souza', tipo: 'exame', procedimento: 'RM JOELHO', plano: 'Particular', unidade: 'CSI', data_ini: '2026-12-01', data_fim: '2026-12-31', dias_semana: [1, 3], turno: 'manha', estado: 'ativa', criado_em: agora, expira_em: agora, ultima_verificacao_em: agora, ultima_verificacao_resultado: 'api_sem_horarios', aceita_notificacao: true, canais: ['chat'], conversa_status: 'aguardando', notificacao: null, precisa_humano: false, historico: [{ em: agora, tipo: 'criada', origem: 'paciente' }] },
  { id: 's2', conversa_id: 'c2', paciente: 'João Lima', tipo: 'consulta', procedimento: 'CARDIOLOGIA', plano: 'Particular', unidade: 'CSI', data_ini: '2026-12-01', data_fim: '2026-12-31', dias_semana: [], turno: 'qualquer', estado: 'oportunidade_identificada', criado_em: agora, expira_em: agora, ultima_verificacao_em: agora, ultima_verificacao_resultado: 'ok_com_horarios', aceita_notificacao: false, canais: [], conversa_status: 'aguardando', notificacao: 'bloqueada_sem_autorizacao', precisa_humano: true, historico: [] },
  { id: 's3', conversa_id: 'c3', paciente: 'Ana Paula', tipo: 'exame', procedimento: 'US ABDOME', plano: 'Particular', unidade: 'CSI', data_ini: '2026-11-01', data_fim: '2026-11-10', dias_semana: [], turno: 'tarde', estado: 'expirada', criado_em: agora, expira_em: agora, ultima_verificacao_em: agora, aceita_notificacao: true, canais: ['chat'], conversa_status: 'encerrada', notificacao: null, precisa_humano: false, historico: [] }] };
const RESUMO = { modos: { mestre: 'sim', horarios: 'sim', marcar: 'sim', percentual: 100, pre_cadastro: 'sim', webhook: 'nao', autogestao: 'sim' }, operacoes: { sucesso: 7, incerto: 1 }, agendadas_sozinhas: 7, resolvidas_sem_humano: 6, tempo_medio_s: 9, motivos_falha: [], cadastros: { confere: 3 }, convenios: { traduzidos: 4, sem_traducao: 1 },
  horarios_api: { ok: 20, erro: 1, limite: 0, api_total: 0, api_na_grade: 0 }, decisoes: [], pos: { 'ler_vouchers:sucesso': 11, 'cancelar:sucesso': 3, 'remarcar:sucesso': 2, 'cancelar:incerto': 1 }, gerado_em: agora };
const CONFIG = [['klingo_auto', 'sim'], ['klingo_api_telefones_teste', ''], ['klingo_api_horarios', 'sombra'], ['klingo_api_marcar', 'teste'], ['klingo_api_pre_cadastro', 'teste'], ['klingo_api_consultar', 'teste'], ['klingo_api_cancelar', 'teste'], ['klingo_api_remarcar', 'teste'], ['previsao_modo', 'teste'],
  ['previsao_monitor_modo', 'nao'], ['notificacao_modo', 'nao'], ['klingo_api_percentual', '100']].map(([chave, valor]) => ({ chave, valor }));
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
    else if (p.endsWith('/rpc/painel_disponibilidade_lista')) { reg.rpcs.push({ rpc: 'lista' }); corpo = DISP; }
    else if (p.endsWith('/rpc/painel_disponibilidade_cancelar')) { reg.rpcs.push({ rpc: 'cancelar', ...JSON.parse(req.postData() || '{}') }); corpo = { ok: true }; }
    else if (p.endsWith('/rpc/painel_automacao_resumo')) corpo = RESUMO;
    else if (p.endsWith('/rpc/painel_indicadores_decisao')) corpo = { periodo: { de: '2026-11-08', ate: '2026-11-14' }, anterior_periodo: { de: '2026-11-01', ate: '2026-11-07' }, atual: {}, anterior: {}, gerado_em: agora };
    else if (p.startsWith('/rest/v1/config')) { if (req.method() === 'PATCH') { reg.rpcs.push({ rpc: 'config', url: url.search, corpo: JSON.parse(req.postData() || '{}') }); corpo = []; } else corpo = CONFIG; }
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
const abrir = async () => { const t = await pagina(browser); await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('.modo', { timeout: 10000 }); return t; };

await caso('DISPONIBILIDADE FUTURA: lista as solicitações com a situação certa, avisa que NÃO é agendamento nem reserva, e o filtro "Precisa de pessoa" mostra só quem precisa', async () => {
  const { page, ctx, reg } = await abrir();
  await page.click('#btnPrevisao'); await page.waitForSelector('#tabPrevisao', { timeout: 8000 });
  const texto = await page.$eval('dialog', (d) => d.textContent.replace(/\s+/g, ' '));
  const antes = await page.$$eval('#tabPrevisao tbody tr', (t) => t.length);
  await page.click('dialog .chip:has-text("Precisam de pessoa")'); await new Promise((r) => setTimeout(r, 300));
  const depois = await page.$$eval('#tabPrevisao tbody tr', (t) => t.map((x) => x.textContent.replace(/\s+/g, ' ')));
  await ctx.close();
  return { ok: /NÃO é agendamento nem reserva/.test(texto) && antes === 3 && depois.length === 1 && /João Lima/.test(depois[0]) && !reg.excecoes.length, detalhe: `linhas=${antes}→${depois.length}; ${reg.excecoes[0] ?? ''}` };
});
await caso('DISPONIBILIDADE FUTURA: "Cancelar procura" chama painel_disponibilidade_cancelar com a solicitação certa e só existe para solicitação aberta', async () => {
  const { page, ctx, reg } = await abrir();
  await page.click('#btnPrevisao'); await page.waitForSelector('#tabPrevisao', { timeout: 8000 });
  const botoes = await page.$$eval('#tabPrevisao tbody tr', (t) => t.map((x) => [x.textContent.includes('Maria Souza'), x.textContent.includes('Ana Paula'), !!x.querySelector('button[title*="Cancela a procura"]')]));
  page.on('dialog', (d) => d.accept());
  await page.click('#tabPrevisao tbody tr:has-text("Maria Souza") button[title*="Cancela a procura"]'); await new Promise((r) => setTimeout(r, 500));
  const cancel = reg.rpcs.find((x) => x.rpc === 'cancelar');
  await ctx.close();
  return { ok: botoes.find((b) => b[0])[2] === true && botoes.find((b) => b[1])[2] === false && !!cancel && JSON.stringify(cancel).includes('s1'), detalhe: JSON.stringify(cancel ?? null) };
});
await caso('CONFIGURAÇÕES: o mestre é "teto" e cada capacidade do autoatendimento tem a sua chave (horários, marcar, pré-cadastro, ver, cancelar, remarcar, disponibilidade, motor de vagas, aviso)', async () => {
  const { page, ctx } = await abrir();
  await page.click('button[data-aba="config"]'); await page.waitForSelector('#cfg-klingoauto', { timeout: 8000 });
  const chaves = await page.$$eval('#cfg-klingoauto select, #cfg-klingoauto input', (e) => e.map((x) => x.id.replace('cfg_', '')));
  const desc = await page.$eval('#cfg-klingoauto .cfg-desc', (e) => e.textContent);
  await ctx.close();
  const esperadas = ['klingo_auto', 'klingo_api_horarios', 'klingo_api_marcar', 'klingo_api_pre_cadastro', 'klingo_api_consultar', 'klingo_api_cancelar', 'klingo_api_remarcar', 'previsao_modo', 'previsao_monitor_modo', 'notificacao_modo', 'klingo_api_percentual'];
  return { ok: esperadas.every((k) => chaves.includes(k)) && /TETO/.test(desc), detalhe: chaves.join(',') };
});
await caso('CONFIGURAÇÕES: alterar UMA chave grava só essa chave (as outras não são tocadas)', async () => {
  const { page, ctx, reg } = await abrir();
  await page.click('button[data-aba="config"]'); await page.waitForSelector('#cfg_klingo_api_cancelar', { timeout: 8000 });
  await page.selectOption('#cfg_klingo_api_cancelar', 'sim');
  await page.click('button:has-text("Salvar alterações")'); await new Promise((r) => setTimeout(r, 600));
  const gravou = reg.rpcs.filter((x) => x.rpc === 'config');
  await ctx.close();
  return { ok: gravou.length === 1 && /klingo_api_cancelar/.test(gravou[0].url) && gravou[0].corpo.valor === 'sim', detalhe: JSON.stringify(gravou) };
});
await caso('INDICADORES: mostra as consultas de marcações, os cancelamentos e as remarcações confirmados pelo Klingo e o que foi para a equipe', async () => {
  const { page, ctx } = await abrir();
  await page.click('button[data-aba="indicadores"]').catch(() => {}); await page.waitForSelector('.ind-auto', { timeout: 10000 });
  const t = await page.$eval('.ind-auto', (e) => e.textContent.replace(/\s+/g, ' '));
  await ctx.close();
  return { ok: /11\s*consultas de marcações/.test(t) && /3\s*cancelamentos confirmados pelo Klingo/.test(t) && /2\s*remarcações confirmadas/.test(t) && /1\s*cancelar\/remarcar que foram para a equipe/.test(t) && /teto/.test(t), detalhe: t.slice(0, 160) };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} passaram`);
process.exit(ok === resultados.length ? 0 : 1);
