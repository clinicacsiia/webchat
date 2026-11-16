// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com as marcações do Klingo e o resultado do executor) -> validação (botão "Marcações" só para admin/atendente; confirmação com data, hora e exame) -> lógica (listar, cancelar, motivos, incerto) -> saída (chamadas ao banco; o paciente não recebe nada)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (Etapa 3: ver e cancelar marcações pelo painel)
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

async function pagina(browser, { nivel = 'supervisor', marcouFalha = false, horarios = null, papel = 'atendente', bd = { horario: null, disponibilidade: null }, marc = {} } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.modo'); } catch {}
  }, [EU.id, jwt(EU.id), EU.email]);
  const reg = { excecoes: [], pedidos: [], rpcs: [], chamadas: [], regs: [], cadastros: [], cancelados: [] };
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
    else if (p.startsWith('/functions/v1/painel-horarios')) { reg.chamadas.push(JSON.parse(req.postData() || '{}')); if (horarios === 'erro') { status = 500; corpo = { error: 'x' }; } else corpo = typeof horarios === 'function' ? horarios(JSON.parse(req.postData() || '{}')) : horarios; }
    else if (p.startsWith('/rest/v1/agentes')) { const eu = { ...EU, papel }; corpo = url.searchParams.get('id') ? (objeto ? eu : [eu]) : [eu, OUTRO]; }
    else if (p.startsWith('/rest/v1/conversas')) corpo = CONVERSAS;
    else if (p.startsWith('/rest/v1/jornada_coluna')) corpo = [];
    else if (p.startsWith('/rest/v1/jornada_transicao')) corpo = [];
    else if (p.startsWith('/rest/v1/v_jornada_quadro')) corpo = [];
    else if (p.endsWith('/rpc/org_nivel')) corpo = nivel;
    else if (p.endsWith('/rpc/painel_indicadores_atendentes')) { reg.rpcs.push(JSON.parse(req.postData() || '{}')); if (marcouFalha) { status = 500; corpo = { message: 'falhou' }; } else corpo = { pessoas: [{ nome: 'Outra Pessoa', agendados: 3 }, { nome: 'Atendente de Teste', agendados: 1 }] }; }
    else if (p.endsWith('/rpc/painel_marcacoes_pedir')) corpo = marc.pedir ?? { ok: true, op: 'o1' };
    else if (p.endsWith('/rpc/painel_marcacoes')) corpo = { consulta: { estado: 'sucesso' }, marcacoes: marc.lista ?? [] };
    else if (p.endsWith('/rpc/painel_marcacao_cancelar')) { const a = JSON.parse(req.postData() || '{}'); reg.cancelados.push(a); corpo = marc.cancelar ?? { ok: true, op: 'o2' }; if (corpo.ok && !marc.mantem) marc.lista = (marc.lista ?? []).filter((m) => m.voucher !== a.p_voucher); }
    else if (p.endsWith('/rpc/painel_marcacao_op')) { const a = JSON.parse(req.postData() || '{}'); corpo = { ok: true, tipo: 'x', estado: a.p_op === 'o2' ? (marc.estadoOp ?? 'sucesso') : 'sucesso', codigo: marc.codigo ?? null }; }
    else if (p.endsWith('/rpc/painel_ofertas')) { corpo = Object.fromEntries(Object.entries(bd).filter(([, e]) => e).map(([k, e]) => [k, { estado: e, em: agora }])); }
    else if (p.endsWith('/rpc/painel_oferta_registrar')) {
      const a = JSON.parse(req.postData() || '{}'); reg.regs.push(a);
      if (a.p_estado === 'oferecido' && ['recusado', 'dispensado'].includes(bd[a.p_tipo])) corpo = { ok: false, bloqueado: true, motivo: 'ja_' + bd[a.p_tipo] };
      else { bd[a.p_tipo] = a.p_estado; corpo = { ok: true, estado: a.p_estado }; }
    }
    else if (p.endsWith('/rpc/painel_disponibilidade_registrar')) { reg.cadastros.push(JSON.parse(req.postData() || '{}')); bd.disponibilidade = 'aceito'; corpo = { ok: true, id: 'd1', data_ini: '2026-11-17', data_fim: '2026-12-16', procedimento: 'X' }; }
    else if (p.startsWith('/rest/v1/respostas_prontas')) corpo = [
      { id: 'r1', atalho: 'LISTA-DE-ESPERA', texto: 'A agenda do(a) Dr(a). {medico} está completa no momento. Podemos deixar o nome do paciente em nossa lista de espera?' },
      { id: 'r2', atalho: 'ACEITOU-LISTA-DE-ESPERA', texto: 'Prontinho! O paciente foi incluído em nossa lista de espera.' },
      { id: 'r3', atalho: 'DEMORA-DE-RESPONDER-HORARIO-OFERTADO', texto: 'Passando para saber se conseguiu verificar as opções de horários que enviamos.' }];
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





const L = () => [
  { voucher: '9001', procedimento: 'CONSULTA PEDIATRIA', unidade: 'CLÍNICA DE SAÚDE E IMAGEM - DESENVOAR', profissional: 'DRA EXEMPLO', data: '2026-11-20', hora: '09:30', origem: 'klingo' },
  { voucher: '9002', procedimento: 'ULTRASSOM DE ABDOME', unidade: 'CSI', profissional: null, data: '2026-11-24', hora: '14:00', origem: 'chat_api' }];
const abrirJoao = async (opcoes) => { const t = await abrir(opcoes); await t.page.click('.chip:has-text("Meus")'); await t.page.click('.item:has-text("João Lima")'); await t.page.waitForSelector('#chatTopo'); return t; };
const abrirMarc = async (page) => { await page.click('#chatTopo button:has-text("Marcações")'); };
const toasts = (page) => page.locator('#toast, .toast').allInnerTexts().catch(() => []);

await caso('Botão "Marcações" na conversa aberta; a lista mostra dia, hora, exame, unidade e profissional de cada marcação futura', async () => {
  const { page, ctx, reg } = await abrirJoao({ marc: { lista: L() } });
  const antes = await page.locator('button:has-text("Marcações")').count();
  await abrirMarc(page); await page.waitForSelector('.marc-linha');
  const txt = await page.locator('.marc-lista').innerText(), n = await page.locator('.marc-linha').count();
  await ctx.close();
  return { ok: antes === 1 && n === 2 && /sex 20\/11 às 09:30/.test(txt) && /consulta pediatria/.test(txt) && /DRA EXEMPLO/.test(txt) && /ter 24\/11 às 14:00/.test(txt) && /ultrassom de abdome/.test(txt) && !reg.excecoes.length, detalhe: txt.replace(/\n/g, ' | ') + (reg.excecoes[0] ?? '') };
});

await caso('Cancelar pede confirmação com data, hora e exame; "Cancelar" da confirmação desiste sem chamar o banco', async () => {
  const { page, ctx, reg } = await abrirJoao({ marc: { lista: L() } });
  let msg = ''; page.on('dialog', async (d) => { msg = d.message(); await d.dismiss(); });
  await abrirMarc(page); await page.waitForSelector('.marc-linha');
  await page.click('.marc-linha[data-voucher="9001"] button:has-text("Cancelar")'); await espera(400);
  await ctx.close();
  return { ok: /sex 20\/11 às 09:30/.test(msg) && /consulta pediatria/.test(msg) && /NÃO é avisado/.test(msg) && reg.cancelados.length === 0, detalhe: msg.replace(/\n/g, ' | ') };
});

await caso('Confirmando: cancela só a marcação escolhida, avisa para falar com o paciente e a lista se atualiza', async () => {
  const { page, ctx, reg } = await abrirJoao({ marc: { lista: L() } });
  page.on('dialog', (d) => d.accept());
  await abrirMarc(page); await page.waitForSelector('.marc-linha');
  await page.click('.marc-linha[data-voucher="9002"] button:has-text("Cancelar")'); await page.waitForSelector('.marc-linha[data-voucher="9001"]'); await espera(500);
  const resto = await page.locator('.marc-linha').count(), t = (await toasts(page)).join(' ');
  await ctx.close();
  return { ok: reg.cancelados.length === 1 && reg.cancelados[0].p_voucher === '9002' && reg.cancelados[0].p_conversa === 'c2' && resto === 1 && /cancelada no Klingo\. Avise o paciente/.test(t), detalhe: JSON.stringify(reg.cancelados) + ' ' + t + ' restam=' + resto };
});

await caso('Klingo não confirma (incerto): aviso para conferir ANTES de tentar de novo e a marcação continua na lista', async () => {
  const { page, ctx } = await abrirJoao({ marc: { lista: L(), estadoOp: 'incerto', mantem: true } });
  page.on('dialog', (d) => d.accept());
  await abrirMarc(page); await page.waitForSelector('.marc-linha');
  await page.click('.marc-linha[data-voucher="9001"] button:has-text("Cancelar")'); await espera(800);
  const t = (await toasts(page)).join(' '), n = await page.locator('.marc-linha').count();
  await ctx.close();
  return { ok: /Confira no Klingo ANTES/.test(t) && n === 2, detalhe: t };
});

await caso('Motivos viram frases claras (desligado, falta CPF, paciente vendo no chat) sem código técnico', async () => {
  const frases = [];
  for (const pedir of [{ ok: false, motivo: 'desligado' }, { ok: false, motivo: 'dados_incompletos', faltando: ['CPF'] }, { ok: false, motivo: 'paciente_vendo' }]) {
    const { page, ctx } = await abrirJoao({ marc: { pedir } });
    await abrirMarc(page); await page.waitForSelector('dialog p.urg'); frases.push(await page.locator('dialog p.urg').innerText()); await ctx.close();
  }
  return { ok: /desligada/.test(frases[0]) && /faltam no pedido: CPF/.test(frases[1]) && /vendo as marcações no chat/.test(frases[2]) && !frases.some((f) => /desligado|dados_incompletos|paciente_vendo/.test(f)), detalhe: frases.join(' || ') };
});

await caso('Paciente sem marcação futura: avisa e oferece consultar de novo', async () => {
  const { page, ctx } = await abrirJoao({ marc: { lista: [] } });
  await abrirMarc(page); await page.waitForSelector('dialog:has-text("Nenhuma marcação futura")');
  const tem = await page.locator('dialog button:has-text("Consultar de novo")').count();
  await ctx.close();
  return { ok: tem === 1, detalhe: '' };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
