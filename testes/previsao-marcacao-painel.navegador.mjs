// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado: lista de conversas e as funções painel_pmarc_*) -> validação (botão "Previsão de marcação" só para admin e atendente)
//   -> lógica (janela com quem foi registrado, o que respondeu ("não sei" vale), filtros, busca, copiar link, WhatsApp com o texto pronto, abrir a conversa)
//   -> saída (PASS/FAIL por caso) | ROLLBACK: reverter painel/index.html e painel/sw.js
// Versão 1.0 — 17/11/2026 / Mudança: primeira versão (Webchat de Previsão de marcação). As funções do banco são simuladas aqui; o banco tem teste próprio (sql-previsao-marcacao.test.mjs).
// (infraestrutura copiada de equipe-agora.navegador.mjs)
// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado: 2 atendentes, fila, conversas esperando e aguardando paciente) -> validação (botão "Equipe agora" só para TI, gerência e supervisão) -> lógica (contagem por atendente a partir das conversas carregadas; "Marcou hoje" vem de painel_indicadores_atendentes) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 12/11/2026 / Mudança: Implementação inicial (quadro "Equipe agora" da chefia no Painel de Atendimento)
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

async function pagina(browser, { nivel = 'supervisor', marcouFalha = false, pmarc = () => ({}), papel = 'atendente' } = {}) {
  const opcoes = { pmarc };
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
    else if (p.startsWith('/rest/v1/agentes')) { const eu = { ...EU, papel }; corpo = url.searchParams.get('id') ? (objeto ? eu : [eu]) : [eu, OUTRO]; }
    else if (p.startsWith('/rest/v1/conversas')) corpo = CONVERSAS;
    else if (p.startsWith('/rest/v1/jornada_coluna')) corpo = [];
    else if (p.startsWith('/rest/v1/jornada_transicao')) corpo = [];
    else if (p.startsWith('/rest/v1/v_jornada_quadro')) corpo = [];
    else if (p.endsWith('/rpc/org_nivel')) corpo = nivel;
    else if (p.includes('/rpc/painel_pmarc_')) { const nome = p.split('/rpc/')[1]; const corpo2 = JSON.parse(req.postData() || '{}'); reg.rpcs.push({ nome, ...corpo2 }); corpo = opcoes.pmarc(nome, corpo2, reg); if (corpo && corpo.__erro) { status = 400; corpo = { message: corpo.__erro }; } }
    else if (p.endsWith('/rpc/painel_indicadores_atendentes')) { reg.rpcs.push(JSON.parse(req.postData() || '{}')); if (marcouFalha) { status = 500; corpo = { message: 'falhou' }; } else corpo = { pessoas: [{ nome: 'Outra Pessoa', agendados: 3 }, { nome: 'Atendente de Teste', agendados: 1 }] }; }
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

const amanha = new Date(Date.now() + 864e5).toISOString();
const PESSOAS = [
  { id: 'p1', codigo: 'abc123abc123abc123abc123', nome: 'MARIA TESTE DA SILVA', celular: '71991230001', email: 'maria@exemplo.invalid', nascimento: '1985-02-03', tem_cpf: true, cpf_informado: false, primeira_vez: false, origem: 'klingo',
    resposta: 'nao_sei', respondeu_em: agora, primeiro_acesso_em: agora, ultimo_acesso_em: agora, link_enviado_em: null, conversa_id: null, observacao: 'Prefiro de manhã', revisar: true, n_itens: 8,
    itens: [{ quando: amanha, procedimento: 'CONSULTA CARDIOLOGIA', unidade: 'CSI', tipo: 'consulta' }, { quando: amanha, procedimento: 'RM JOELHO', unidade: 'RM/TC', tipo: 'exame' }], proximo_em: amanha },
  { id: 'p2', codigo: 'zzz999zzz999zzz999zzz999', nome: 'JOSÉ SEM CELULAR', celular: null, email: null, nascimento: null, tem_cpf: false, cpf_informado: false, primeira_vez: true, origem: 'klingo',
    resposta: null, respondeu_em: null, primeiro_acesso_em: null, ultimo_acesso_em: null, link_enviado_em: null, conversa_id: null, observacao: null, revisar: false, n_itens: 1,
    itens: [{ quando: amanha, procedimento: 'ULTRASSOM ABDOME', unidade: 'DESENVOAR', tipo: 'exame' }], proximo_em: amanha },
];
const RESUMO = { ligado: true, total: 2, sem_celular: 1, link_enviado: 0, abriram: 1, responderam: 1, nao_sei: 1, com_conversa: 0 };
const mock = (extra = {}) => (nome, corpo, reg) => {
  if (extra[nome]) return extra[nome](corpo, reg);
  if (nome === 'painel_pmarc_resumo') return RESUMO;
  if (nome === 'painel_pmarc_estado') return { completo_em: agora, rapido_em: agora, erro: null, resultado: {} };
  if (nome === 'painel_pmarc_lista') return PESSOAS.filter((p) => (corpo.p_filtro === 'nao_sei' ? p.resposta === 'nao_sei' : true) && (!corpo.p_busca || p.nome.toLowerCase().includes(String(corpo.p_busca).toLowerCase())));
  if (nome === 'painel_pmarc_link_enviado') return 1;
  return {};
};

const srv = await servidor();
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox'] } : {});
const abrir = async (opcoes) => { const t = await pagina(browser, opcoes); await t.page.goto(`${base}/painel/`); await t.page.waitForSelector('.modo', { timeout: 10000 }); return t; };
const rpcs = (reg, nome) => reg.rpcs.filter((r) => r.nome === nome);

await caso('admin e atendente veem o botão "Previsão de marcação"; marketing não vê', async () => {
  const a = await abrir({ pmarc: mock() });
  const ate = await a.page.locator('#btnPrevMarc').count(); await a.ctx.close();
  const m = await pagina(browser, { pmarc: mock(), papel: 'marketing' }); await m.page.goto(`${base}/painel/`); await espera(2500);
  const mkt = await m.page.locator('#btnPrevMarc').count(); await m.ctx.close();
  return { ok: ate === 1 && mkt === 0, detalhe: `atendente=${ate} marketing=${mkt}` };
});

await caso('a janela mostra o resumo, a previsão de cada pessoa e o que ela respondeu ("não sei" vale)', async () => {
  const { page, ctx, reg } = await abrir({ pmarc: mock() });
  await page.click('#btnPrevMarc'); await page.waitForSelector('#tabPrevMarc tbody tr');
  const t = await page.locator('dialog').innerText();
  if (process.env.FOTO) await page.screenshot({ path: process.env.FOTO });
  await ctx.close();
  return { ok: /PREVISÃO, não uma confirmação/.test(t) && /2 pessoa\(s\) registrada\(s\)/.test(t) && /MARIA TESTE DA SILVA/.test(t) && /Consulta: CONSULTA CARDIOLOGIA/.test(t) && /\+ 6 marcação\(ões\)/.test(t)
    && /Não sabe \/ pode seguir/.test(t) && /Prefiro de manhã/.test(t) && /conferir/.test(t) && /Sem celular: anote por telefone/.test(t) && /Ainda não respondeu/.test(t) && /Não abriu o link/.test(t) && !reg.excecoes.length,
    detalhe: reg.excecoes[0] ?? t.slice(0, 200).replace(/\n/g, ' | ') };
});

await caso('o filtro "Não sei" e a busca pedem ao banco só o que é preciso (e a tela atualiza)', async () => {
  const { page, ctx, reg } = await abrir({ pmarc: mock() });
  await page.click('#btnPrevMarc'); await page.waitForSelector('#tabPrevMarc tbody tr');
  await page.click('button[data-pm-filtro="nao_sei"]'); await espera(600);
  const linhasFiltro = await page.locator('#tabPrevMarc tbody tr').count();
  await page.fill('#pmBusca', 'maria'); await espera(900);
  const ult = rpcs(reg, 'painel_pmarc_lista').at(-1);
  await ctx.close();
  return { ok: linhasFiltro === 1 && ult.p_filtro === 'nao_sei' && ult.p_busca === 'maria' && ult.p_limite === 50 && ult.p_pular === 0, detalhe: JSON.stringify({ linhasFiltro, ult }) };
});

await caso('"Copiar link" copia o link pessoal e marca como enviado', async () => {
  const { page, ctx, reg } = await abrir({ pmarc: mock() });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await page.click('#btnPrevMarc'); await page.waitForSelector('#tabPrevMarc tbody tr');
  await page.click('tr[data-pm-id="p1"] button[data-pm="copiar"]'); await espera(500);
  const copiado = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  const marcou = rpcs(reg, 'painel_pmarc_link_enviado');
  const t = await page.locator('dialog').innerText();
  await ctx.close();
  return { ok: copiado === `${base}/previsao/?c=abc123abc123abc123abc123` && marcou.length === 1 && marcou[0].p_id === 'p1' && /Link enviado:/.test(t), detalhe: JSON.stringify({ copiado, marcou }) };
});

await caso('"WhatsApp com o link" abre wa.me com o texto pronto (e avisa que é previsão); sem celular não tem WhatsApp', async () => {
  const { page, ctx } = await abrir({ pmarc: mock() });
  await page.click('#btnPrevMarc'); await page.waitForSelector('#tabPrevMarc tbody tr');
  const href = await page.getAttribute('tr[data-pm-id="p1"] a[data-pm="zap"]', 'href');
  const semZap = await page.locator('tr[data-pm-id="p2"] a[data-pm="zap"]').count();
  const semCel = await page.locator('tr[data-pm-id="p2"] [data-pm="sem-celular"]').count();
  const texto = decodeURIComponent((href || '').split('text=')[1] || '');
  await ctx.close();
  return { ok: href.startsWith('https://wa.me/5571991230001?text=') && /Olá, Maria!/.test(texto) && /PREVISÃO/.test(texto) && texto.includes('/previsao/?c=abc123abc123abc123abc123') && semZap === 0 && semCel === 1, detalhe: texto.slice(0, 160) };
});

await caso('"Iniciar conversa" cria a conversa, fecha a janela e abre a conversa na lista de atendimento', async () => {
  const novaConversa = { ...CONVERSAS[0], id: 'c-prev', nome_informado: 'MARIA TESTE DA SILVA', contatos: { id: 'ct-p', nome: 'MARIA TESTE DA SILVA', telefone: '71991230001', email: null } };
  const { page, ctx, reg } = await abrir({ pmarc: mock({ painel_pmarc_conversa: () => 'c-prev' }) });
  await page.click('#btnPrevMarc'); await page.waitForSelector('#tabPrevMarc tbody tr');
  await page.click('tr[data-pm-id="p1"] button[data-pm="conversa"]'); await espera(900);
  const chamou = rpcs(reg, 'painel_pmarc_conversa');
  const aberto = await page.locator('dialog[open]').count();
  await ctx.close();
  return { ok: chamou.length === 1 && chamou[0].p_id === 'p1' && aberto === 0 && !reg.excecoes.length, detalhe: JSON.stringify({ chamou, aberto, exc: reg.excecoes[0] }) };
});

await caso('sem celular o banco recusa e o painel explica, sem quebrar', async () => {
  const { page, ctx, reg } = await abrir({ pmarc: mock({ painel_pmarc_conversa: () => ({ __erro: 'Sem celular para abrir a conversa. Anote o celular com a pessoa por telefone.' }) }) });
  await page.click('#btnPrevMarc'); await page.waitForSelector('#tabPrevMarc tbody tr');
  await page.click('tr[data-pm-id="p1"] button[data-pm="conversa"]'); await espera(700);
  const ainda = await page.locator('dialog[open]').count();
  const toast = await page.locator('body').innerText();
  await ctx.close();
  return { ok: ainda === 1 && /Sem celular para abrir a conversa/.test(toast) && !reg.excecoes.length, detalhe: reg.excecoes[0] ?? '' };
});

await caso('registro desligado: avisa com clareza na janela', async () => {
  const { page, ctx } = await abrir({ pmarc: mock({ painel_pmarc_resumo: () => ({ ...RESUMO, ligado: false, total: 0 }), painel_pmarc_lista: () => [] }) });
  await page.click('#btnPrevMarc'); await page.waitForSelector('[data-pm="desligado"]');
  const t = await page.locator('dialog').innerText();
  await ctx.close();
  return { ok: /DESLIGADO/.test(t) && /previsao_marcacao_modo/.test(t) && /Ninguém nesta lista ainda/.test(t) };
});

await caso('erro ao carregar não trava: mostra aviso e a janela fecha normalmente', async () => {
  const { page, ctx } = await abrir({ pmarc: mock({ painel_pmarc_lista: () => ({ __erro: 'falhou' }) }) });
  await page.click('#btnPrevMarc'); await page.waitForSelector('[role=alert]');
  const t = await page.locator('dialog').innerText();
  await page.click('dialog .rodape button'); await espera(200);
  const aberto = await page.locator('dialog[open]').count();
  await ctx.close();
  return { ok: /Não foi possível carregar agora/.test(t) && aberto === 0 };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
