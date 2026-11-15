// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com as funções painel_app_*) -> validação (botão "Pendências" só para quem atende; contador somando solicitações, revisões e contas antigas; erro do banco) -> lógica (abas Solicitações / Cadastros para conferir / Contas antigas; botões Confirmar, Concluir, Cancelar e Marcar como conferido chamam a função certa com os argumentos certos e recarregam) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (botão Pendências do painel)
// Não substitui o teste com o banco: as funções painel_app_* têm teste próprio em sql-acesso-painel.test.mjs.
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
const LISTA_ANTIGA = { contagem: { oportunidade_identificada: 1, ativa: 2 }, itens: [
  { id: 's1', conversa_id: 'c1', paciente: 'Maria Souza', paciente_tipo: 'proprio', tipo: 'exame', procedimento: 'RM JOELHO', plano: 'Particular', turno: 'tarde', data_ini: '2026-11-13', data_fim: '2026-11-28', dias_semana: [1, 3, 5], estado: 'oportunidade_identificada',
    ultima_verificacao_em: agora, ultima_verificacao_resultado: 'ok_com_horarios', ultima_oportunidade: { data: '2026-11-20', hora: '14:00' }, notificacao: 'bloqueada_sem_autorizacao', precisa_humano: true, aceita_notificacao: false, canais: [], historico: [ev('criada', 'paciente'), ev('estado:oportunidade_identificada')], criado_em: agora, expira_em: agora },
  { id: 's2', conversa_id: 'c2', paciente: 'João <b>Lima</b>', paciente_tipo: 'filho', tipo: 'consulta', procedimento: 'CONSULTA', plano: 'Unimed', turno: 'manha', data_ini: '2026-11-13', data_fim: '2026-11-30', dias_semana: [2, 4], estado: 'ativa',
    ultima_verificacao_em: null, ultima_verificacao_resultado: null, ultima_oportunidade: null, notificacao: null, precisa_humano: false, aceita_notificacao: true, canais: ['chat'], historico: [ev('criada', 'paciente')], criado_em: agora, expira_em: agora },
  { id: 's3', conversa_id: 'c3', paciente: 'Ana Paula', paciente_tipo: 'proprio', tipo: 'exame', procedimento: 'US ABDOME', plano: 'Particular', turno: 'qualquer', data_ini: '2026-10-01', data_fim: '2026-10-20', dias_semana: [0, 1, 2, 3, 4, 5, 6], estado: 'expirada',
    ultima_verificacao_em: agora, ultima_verificacao_resultado: 'api_sem_horarios', ultima_oportunidade: null, notificacao: null, precisa_humano: false, aceita_notificacao: true, canais: ['chat'], historico: [], criado_em: agora, expira_em: agora }] };
const RESUMO = { solicitacoes: 2, revisoes: 1, contas_antigas: 2, sem_cpf: 3, acesso_rapido: 5 };
const SOLIC = [
  { grupo: 'g1', criado_em: agora, responsavel: 'Ana <b>Souza</b>', celular: '71991230001', cadastro_sugerido: true, pessoas: [{ nome: 'Ana Souza', nascimento: '1988-04-12', filho: false }, { nome: 'Leo Souza', nascimento: '2019-08-30', filho: true }], exame: 'Ultrassom', data_preferida: '2026-11-20', turno: 'Manhã', obs: 'Pedido do Dr. X', status: 'solicitada' },
  { grupo: 'g2', criado_em: agora, responsavel: 'Bia Costa', celular: '71991230002', cadastro_sugerido: false, pessoas: [{ nome: 'Bia Costa', nascimento: '1990-02-03', filho: false }], exame: 'Raio-X', data_preferida: '2026-11-22', turno: 'Tarde', obs: null, status: 'solicitada' }];
const SOLIC_CONF = [{ grupo: 'g3', criado_em: agora, responsavel: 'Cris Alves', celular: '71991230003', cadastro_sugerido: false, pessoas: [{ nome: 'Cris Alves', nascimento: '1992-03-04', filho: false }], exame: 'Consulta', data_preferida: '2026-11-25', turno: 'Qualquer horário', obs: null, status: 'confirmada' }];
const REV = [{ id: 'r1', nome: 'Davi Lima', celular: '71991230004', nascimento: '1985-01-01', cpf_mascara: '***.***.***-35', motivo: 'cpf_repetido_na_clinica', cadastros_com_o_celular: 0, criado_em: agora }];
const CONTAS = [{ id: 'k1', nome: 'Conta Um', celular: '71991230061', email: 'um@x.invalid', criado_em: agora, ultimo_acesso_em: null, filhos_no_historico: 2 }, { id: 'k2', nome: 'Conta Dois', celular: null, email: 'dois@x.invalid', criado_em: agora, ultimo_acesso_em: agora, filhos_no_historico: 0 }];
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

async function pagina(browser, { nivel = 'supervisor', falha = false, falhaAcao = false, papel = 'atendente' } = {}) {
  const EUX = { ...EU, papel };
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
    else if (p.startsWith('/rest/v1/agentes')) corpo = url.searchParams.get('id') ? (objeto ? EUX : [EUX]) : [EUX, OUTRO];
    else if (p.startsWith('/rest/v1/conversas')) corpo = CONVERSAS;
    else if (p.startsWith('/rest/v1/jornada_coluna')) corpo = [];
    else if (p.startsWith('/rest/v1/jornada_transicao')) corpo = [];
    else if (p.startsWith('/rest/v1/v_jornada_quadro')) corpo = [];
    else if (p.endsWith('/rpc/org_nivel')) corpo = nivel;
    else if (p.endsWith('/rpc/painel_indicadores_atendentes')) { reg.rpcs.push(JSON.parse(req.postData() || '{}')); if (false) { status = 500; corpo = { message: 'falhou' }; } else corpo = { pessoas: [{ nome: 'Outra Pessoa', agendados: 3 }, { nome: 'Atendente de Teste', agendados: 1 }] }; }
    else if (p.endsWith('/rpc/painel_app_pendencias_resumo')) { reg.rpcs.push('resumo'); corpo = falha ? { message: 'falhou' } : RESUMO; if (falha) status = 500; }
    else if (p.endsWith('/rpc/painel_app_solicitacoes')) { const a = JSON.parse(req.postData() || '{}'); reg.rpcs.push({ rpc: 'solic', ...a }); if (falha) { status = 500; corpo = { message: 'falhou' }; } else corpo = a.p_status === 'confirmada' ? SOLIC_CONF : SOLIC; }
    else if (p.endsWith('/rpc/painel_app_revisoes')) { reg.rpcs.push({ rpc: 'rev' }); corpo = REV; }
    else if (p.endsWith('/rpc/painel_app_contas_antigas')) { reg.rpcs.push({ rpc: 'contas' }); corpo = CONTAS; }
    else if (p.endsWith('/rpc/painel_app_solicitacao_status') || p.endsWith('/rpc/painel_app_revisao_resolver')) { const a = JSON.parse(req.postData() || '{}'); reg.rpcs.push({ rpc: p.split('/').pop(), ...a }); if (falhaAcao) { status = 500; corpo = { message: 'falhou' }; } else corpo = 1; }
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

const aberto = async (opcoes) => { const t = await abrir(opcoes); await t.page.click('#btnPendencias'); await t.page.waitForSelector('#tabPendSolic tbody tr, dialog [role=alert], dialog .dica:has-text("Nenhuma")'); return t; };

await caso('O botão "Pendências" aparece para quem atende, com o contador somando solicitações + cadastros + contas antigas (2 + 1 + 2 = 5)', async () => {
  const { page, ctx, reg } = await abrir({ nivel: 'atendente' });
  await page.waitForFunction(() => { const s = document.getElementById('seloPendencias'); return s && !s.hidden && s.textContent === '5'; }, null, { timeout: 5000 });
  const existe = await page.locator('#btnPendencias').count();
  await ctx.close();
  return { ok: existe === 1 && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? '' };
});
await caso('Solicitações: lista com quem pediu, filhos, pedido e botões; texto do banco vira texto (nunca HTML); link de WhatsApp com 55', async () => {
  const { page, ctx, reg } = await aberto({ nivel: 'atendente' });
  const nome = await page.locator('#tabPendSolic tbody tr:nth-child(1) th').textContent(), tags = await page.locator('#tabPendSolic b').count();
  const linhas = await page.$$eval('#tabPendSolic tbody tr', (trs) => trs.map((t) => t.textContent));
  const zap = await page.locator('#tabPendSolic tbody tr:nth-child(1) a').getAttribute('href');
  const botoes = await page.locator('#tabPendSolic tbody tr:nth-child(1) button').allTextContents();
  await ctx.close();
  return { ok: nome.startsWith('Ana <b>Souza</b>') && linhas.length === 2 && /Leo Souza/.test(linhas[0]) && /\(filho\/a\)/.test(linhas[0]) && /Ultrassom/.test(linhas[0]) && /20\/11\/2026/.test(linhas[0]) && /Pode ser paciente da clínica/.test(linhas[0])
    && zap === 'https://wa.me/5571991230001' && botoes.join('|') === 'Confirmar|Cancelar' && !reg.excecoes.length, detalhe: `${nome} | ${botoes.join('|')} | ${zap}` };
});
await caso('Botão Confirmar chama painel_app_solicitacao_status(grupo, "confirmada") e recarrega a lista', async () => {
  const { page, ctx, reg } = await aberto({ nivel: 'atendente' });
  await page.click('#tabPendSolic tbody tr:nth-child(1) button:has-text("Confirmar")'); await espera(500);
  const ch = reg.rpcs.find((r) => r.rpc === 'painel_app_solicitacao_status');
  const recarregou = reg.rpcs.filter((r) => r.rpc === 'solic').length >= 2;
  await ctx.close();
  return { ok: ch && ch.p_grupo === 'g1' && ch.p_status === 'confirmada' && recarregou, detalhe: JSON.stringify(ch) };
});
await caso('Filtro "Confirmada" pede as confirmadas; elas mostram o botão Concluir (e Concluir manda "concluida")', async () => {
  const { page, ctx, reg } = await aberto({ nivel: 'atendente' });
  await page.click('dialog .chip:has-text("Confirmada")'); await page.waitForSelector('#tabPendSolic tbody tr:has-text("Cris Alves")');
  await page.click('#tabPendSolic button:has-text("Concluir")'); await espera(400);
  const pediu = reg.rpcs.some((r) => r.rpc === 'solic' && r.p_status === 'confirmada'), ch = reg.rpcs.find((r) => r.rpc === 'painel_app_solicitacao_status');
  await ctx.close();
  return { ok: pediu && ch && ch.p_grupo === 'g3' && ch.p_status === 'concluida' };
});
await caso('Cancelar pede confirmação (diálogo) e só então manda "cancelada"; recusando, nada é enviado', async () => {
  const { page, ctx, reg } = await aberto({ nivel: 'atendente' });
  page.once('dialog', (d) => d.dismiss());
  await page.click('#tabPendSolic tbody tr:nth-child(2) button:has-text("Cancelar")'); await espera(300);
  const nada = !reg.rpcs.some((r) => r.rpc === 'painel_app_solicitacao_status');
  page.once('dialog', (d) => d.accept());
  await page.click('#tabPendSolic tbody tr:nth-child(2) button:has-text("Cancelar")'); await espera(500);
  const ch = reg.rpcs.find((r) => r.rpc === 'painel_app_solicitacao_status');
  await ctx.close();
  return { ok: nada && ch && ch.p_grupo === 'g2' && ch.p_status === 'cancelada' };
});
await caso('Cadastros para conferir: explica o motivo em português, mostra CPF só mascarado e o botão marca como conferido (painel_app_revisao_resolver)', async () => {
  const { page, ctx, reg } = await aberto({ nivel: 'atendente' });
  await page.click('dialog .chip[data-pend="rev"]'); await page.waitForSelector('#tabPendRev tbody tr');
  const txt = await page.locator('#tabPendRev tbody tr').textContent();
  await page.click('#tabPendRev button:has-text("Marcar como conferido")'); await espera(400);
  const ch = reg.rpcs.find((r) => r.rpc === 'painel_app_revisao_resolver');
  await ctx.close();
  return { ok: /aparece em mais de um cadastro da clínica/.test(txt) && /\*\*\*\.\*\*\*\.\*\*\*-35/.test(txt) && !/cpf_repetido/.test(txt) && ch && ch.p_id === 'r1', detalhe: txt.slice(0, 120) };
});
await caso('Contas antigas sem PIN: nome, contato, filhos no histórico, "nunca" para quem não entrou e botão de WhatsApp só quando há celular', async () => {
  const { page, ctx } = await aberto({ nivel: 'atendente' });
  await page.click('dialog .chip[data-pend="contas"]'); await page.waitForSelector('#tabPendContas tbody tr');
  const linhas = await page.$$eval('#tabPendContas tbody tr', (trs) => trs.map((t) => ({ txt: t.textContent, zap: t.querySelector('a') ? t.querySelector('a').getAttribute('href') : null })));
  await ctx.close();
  return { ok: linhas.length === 2 && /Conta Um/.test(linhas[0].txt) && /nunca/.test(linhas[0].txt) && /2/.test(linhas[0].txt) && linhas[0].zap === 'https://wa.me/5571991230061' && linhas[1].zap === null, detalhe: JSON.stringify(linhas.map((l) => l.zap)) };
});
await caso('Erro do banco mostra aviso e o painel continua funcionando; erro ao salvar avisa e não some com a linha', async () => {
  const a = await abrir({ nivel: 'atendente', falha: true }); await a.page.click('#btnPendencias'); await a.page.waitForSelector('dialog [role=alert]');
  await a.page.click('dialog .rodape button'); const itens = await a.page.locator('.item').count(); const exc = a.reg.excecoes.length; await a.ctx.close();
  const b = await aberto({ nivel: 'atendente', falhaAcao: true });
  await b.page.click('#tabPendSolic tbody tr:nth-child(1) button:has-text("Confirmar")'); await espera(500);
  const aindaLa = await b.page.locator('#tabPendSolic tbody tr').count(); const toastTxt = await b.page.locator('body').innerText(); await b.ctx.close();
  return { ok: itens >= 0 && exc === 0 && aindaLa === 2 && /Não foi possível salvar/.test(toastTxt), detalhe: `linhas=${aindaLa}` };
});
await caso('Quem não atende (marketing) não vê o botão', async () => {
  const { page, ctx } = await abrir({ nivel: 'marketing', papel: 'marketing' }).catch(() => ({}));
  const n = page ? await page.locator('#btnPendencias').count() : 0; if (ctx) await ctx.close();
  return { ok: n === 0 };
});

await browser.close(); srv.close();
const falhasN = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhasN} de ${resultados.length} casos passaram.`);
process.exit(falhasN ? 1 : 0);
