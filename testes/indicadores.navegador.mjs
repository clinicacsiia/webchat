// FLUXOGRAMA: entrada (painel servido localmente + Supabase simulado com conversas de hoje, duas delas da mesma pessoa e uma de teste da TI) -> validação (cartões do topo e aba Indicadores) -> lógica (pessoas atendidas = quem a equipe assumiu ou respondeu hoje; teste fora; período livre com atalhos; sem "Conversas por pessoa" nem "Confirmaram"; unidade e teste vão para as três consultas) -> saída (PASS/FAIL e código de saída)
// Versão 2.0 — 10/11/2026 / Mudança: indicadores novos (IND-01 a IND-05). Versão 1.0 (09/11/2026): indicadores por unidade.
//
// Não substitui o teste com o Supabase real: as funções do banco são simuladas aqui. As contas do banco (supabase/indicadores-v2.sql) são provadas em testes/sql-indicadores-v2.test.mjs.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const RAIZ = resolve(import.meta.dirname, '..');
const UMD = resolve(import.meta.dirname, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const HOST = 'nrvuynjwcgwpjdptkiay.supabase.co';
const EU = { id: '11111111-1111-4111-8111-111111111111', nome: 'Atendente de Teste', email: 'a@teste.local', papel: 'atendente', ativo: true };
const ADM = { ...EU, nome: 'Admin de Teste', papel: 'admin' };
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const agora = new Date().toISOString();
const isoSP = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const mais = (iso, n) => { const [a, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10); };
const HOJE = isoSP();
const conversa = (id, nome, status, unidade, extra = {}) => ({ id, status, agente_id: null, ultima_mensagem: 'oi', nao_lidas_agente: 0, criado_em: agora, atualizado_em: agora, contato_id: 'ct-' + id, ia_ativa: false, motor: 'fluxo',
  triagem_resumo: null, triagem_urgencia: null, alerta_agenda: null, nome_informado: nome, email_informado: null, unidade_inicial: unidade, cliente_aguarda_desde: null, aguarda_paciente_desde: null,
  teste: false, primeiro_humano_em: null, encerrada_em: null, contatos: { id: 'ct-' + id, nome, telefone: '7190000' + id.slice(1), email: null }, ...extra });
// c1 e c2 são a mesma pessoa (c1 ainda sem ninguém, c2 atendida); c4 é da CSI; c5 foi encerrada hoje; c6 é conversa de TESTE da TI.
const CONVERSAS = [conversa('c1', 'Maria Souza', 'aguardando', 'desenvoar'), conversa('c2', 'Maria Souza', 'em_atendimento', 'desenvoar', { primeiro_humano_em: agora }),
  conversa('c3', 'Ana Paula', 'em_atendimento', 'desenvoar', { primeiro_humano_em: agora }), conversa('c4', 'Pedro Alves', 'em_atendimento', 'csi', { primeiro_humano_em: agora }),
  conversa('c5', 'Lia Nunes', 'encerrada', 'desenvoar', { primeiro_humano_em: agora, encerrada_em: agora }), conversa('c6', 'Teste da TI', 'em_atendimento', 'desenvoar', { teste: true, primeiro_humano_em: agora })];
const antes = new Date(Date.now() - 3600e3).toISOString();
CONVERSAS[2].aguarda_paciente_desde = antes; CONVERSAS[3].aguarda_paciente_desde = antes; CONVERSAS[3].cliente_aguarda_desde = antes;
const GRUPOS = [{ conversa_id: 'c1', grupo_id: 'g1', sinais: ['nome'], origem: 'auto', confirmado_por: null }, { conversa_id: 'c2', grupo_id: 'g1', sinais: ['nome'], origem: 'auto', confirmado_por: null }];
// Respostas de painel_indicadores_decisao (supabase/indicadores-decisao.sql). Por unidade: "desenvoar" = 40 pessoas; "rmtc" = poucas pessoas (4 agora, 3 antes).
const DECISAO = (a) => {
  const un = a.p_unidade, pequeno = un === 'rmtc', ent = pequeno ? 4 : un === 'desenvoar' ? 40 : 60;
  const atual = { chat: { entraram: ent, funil: { entraram: ent, pedido: pequeno ? 3 : 45, data_hora: pequeno ? 2 : 40, horario: pequeno ? 2 : 22, completo: pequeno ? 1 : 20, agendaram: pequeno ? 1 : un === 'desenvoar' ? 10 : 15 },
      parou_em: { conversou: 15, exame: 2, plano: 1, preferencias: 0, data_hora: 18, dados: 2, pronto: 5 }, sem_agendar_motivo: { nao_respondido: 20, sem_equipe: 5, apenas_informacoes: 10, desistiu: 3, outro: 2, em_andamento: 5 }, espera_mediana_min: 20,
      por_tipo: { consulta: { pedido: 42, data_hora: 38, horario: 21, completo: 19, agendaram: 14 }, exame: { pedido: 3, data_hora: 2, horario: 1, completo: 1, agendaram: 1 } } },
    clinica: { novas_marcacoes: 200, novas_pelo_chat: 15, previstos: 300, atendidos: 200, faltaram: 50, cancelados: 20, remarcados: 15, por_vir: 15,
      falta_confirmacao: [{ nome: 'Confirmado', atendidos: 150, faltaram: 20 }, { nome: 'Sem Resposta', atendidos: 30, faltaram: 25 }],
      falta_antecedencia: [{ nome: 'No mesmo dia ou no dia seguinte', atendidos: 90, faltaram: 5 }, { nome: 'Mais de 15 dias antes', atendidos: 60, faltaram: 20 }],
      falta_unidade: [{ nome: 'CSI 1', atendidos: 120, faltaram: 30 }, { nome: 'CSI 2', atendidos: 80, faltaram: 20 }], falta_plano: [{ nome: 'Convênio', atendidos: 170, faltaram: 40 }, { nome: 'Particular', atendidos: 30, faltaram: 10 }],
      cancel_motivos: { paciente_cancelou: 9, erro_duplicidade: 6, sem_motivo: 3, convenio_cobertura: 2 } } };
  const anterior = { chat: { entraram: pequeno ? 3 : 50, funil: { entraram: pequeno ? 3 : 50, pedido: 40, data_hora: 35, horario: 28, completo: 25, agendaram: pequeno ? 1 : 20 }, parou_em: {}, sem_agendar_motivo: {}, espera_mediana_min: 8 },
    clinica: { novas_marcacoes: 250, novas_pelo_chat: 30, previstos: 300, atendidos: 220, faltaram: 30, cancelados: 10, remarcados: 10, por_vir: 30, falta_confirmacao: [], falta_antecedencia: [], falta_unidade: [], falta_plano: [], cancel_motivos: {} } };
  atual.clinica_consulta = { ...atual.clinica, previstos: 90, atendidos: 60, faltaram: 10, cancelados: 10, remarcados: 5, por_vir: 5, novas_marcacoes: 60 };
  atual.clinica_exame = { ...atual.clinica, previstos: 210, atendidos: 140, faltaram: 40, cancelados: 10, remarcados: 10, por_vir: 10, novas_marcacoes: 140 };
  return { periodo: { de: a.p_de, ate: a.p_ate }, anterior_periodo: { de: mais(a.p_de, -1), ate: mais(a.p_de, -1) }, unidade: un, incluir_teste: !!a.p_incluir_teste, gerado_em: agora, atual, anterior };
};
const ATENDENTES = (a) => ({ periodo: { de: a.p_de, ate: a.p_ate }, unidade: a.p_unidade, gerado_em: agora, nota_media_geral: 8.5,
  pessoas: [{ nome: 'Ana', conversas: 40, agendados: 12, avaliacoes: 8, nota_media: 9.4, primeiras: 30, espera_mediana_min: 6 }, { nome: 'Bia', conversas: 25, agendados: 3, avaliacoes: 2, nota_media: 6.5, primeiras: 9, espera_mediana_min: 45 }, { nome: 'Caio', conversas: 10, agendados: 0, avaliacoes: 0, nota_media: null, primeiras: 1, espera_mediana_min: 12 }] });
const EXTRAS = (admin) => ({ por_hora: [], pedidos: {}, avaliacoes: admin ? { total: 10, media_atendimento: 8.5, media_site: 7.9, por_canal: { WhatsApp: 4, Instagram: 5, Google: 1 } } : null });
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


// Respostas de painel_indicadores_plataforma (marcações do chat, consulta x exame). Tudo inventado; total = canceladas + remarcadas + ativas.
const PLATAFORMA = { conversas: 38, total: { total: 134, canceladas: 5, remarcadas: 7, ativas: 122, atendidas: 17, faltaram: 3, por_vir: 102, sem_dado: 0 },
  por_tipo: { consulta: { total: 122, canceladas: 4, remarcadas: 5, ativas: 113, atendidas: 15, faltaram: 3, por_vir: 95, sem_dado: 0 }, exame: { total: 12, canceladas: 1, remarcadas: 2, ativas: 9, atendidas: 2, faltaram: 0, por_vir: 7, sem_dado: 0 } },
  por_origem: { Whatsapp: 40, Telefone: 20, Webchat: 1, sem_origem: 73 }, por_ligacao: { pedido: 100, telefone_nome: 34 }, cancel_motivos: { paciente_cancelou: 3, sem_motivo: 2 }, clinica_mesmo_periodo: { consulta: 559, exame: 2215 } };
// Respostas de painel_indicadores_mensal (gráfico mensal). Tudo inventado; total = atendidos + faltaram + cancelados + remarcados + por vir.
const MENSAL = { de: '2026-06-01', ate: '2026-11-01', meses: [
  { mes: '2026-06', total: 0, atendidos: 0, faltaram: 0, cancelados: 0, remarcados: 0, por_vir: 0 }, { mes: '2026-07', total: 0, atendidos: 0, faltaram: 0, cancelados: 0, remarcados: 0, por_vir: 0 },
  { mes: '2026-08', total: 0, atendidos: 0, faltaram: 0, cancelados: 0, remarcados: 0, por_vir: 0 }, { mes: '2026-09', total: 0, atendidos: 0, faltaram: 0, cancelados: 0, remarcados: 0, por_vir: 0 },
  { mes: '2026-10', total: 432, atendidos: 273, faltaram: 59, cancelados: 62, remarcados: 38, por_vir: 0 }, { mes: '2026-11', consulta: { total: 1546, atendidos: 700, faltaram: 100, cancelados: 200, remarcados: 246, por_vir: 300 }, exame: { total: 4255, atendidos: 1655, faltaram: 351, cancelados: 463, remarcados: 465, por_vir: 1321 }, total: 5807, atendidos: 2355, faltaram: 451, cancelados: 663, remarcados: 711, por_vir: 1627 }] };
// Respostas de painel_indicadores_conferencia (supabase/klingo-conferencia.sql) e de paciente_avisos com os dois tipos novos. Tudo inventado.
const CONFERENCIA = {
  periodo: { de: HOJE, ate: HOJE }, ultima_leitura: `${HOJE}T15:00:00Z`, dias_sem_leitura: [], total: 200,
  por_origem: { Whatsapp: 90, Telefone: 60, 'Recepção': 30, sem_origem: 20 }, por_status: { Aberta: 170, Cancelada: 30 },
  explicacao: { no_banco: 170, fora_do_banco: 30, remarcadas: 10, novas_marcacoes_indicador: 160, canceladas_no_klingo: 30 },
  webchat: { marcacoes_ligadas: 40, conversas_ligadas: 38, por_ligacao: { pedido: 25, telefone_nome: 15 }, por_origem: { Whatsapp: 36, Telefone: 4 },
    exames: { atendido: 15, faltou: 3, por_vir: 18, cancelado_ou_remarcado: 2, ainda_fora_do_banco: 2 },
    pessoas_que_procuraram: 60, atendidas_pela_equipe: 52, com_pedido_pronto: 30, agendaram_no_chat: 25, agendaram_e_ligadas_ao_klingo: 22, agendadas_sem_marcacao_no_klingo: 3 },
  qualidade_klingo: { sem_cpf: 64, sem_email: 92, sem_celular: 6 },
  problemas: { conflito: 3, dado_faltando: 4, responsavel_diferente_esperado: 9, filho_nos_ligados: 30 },
  lista_problemas: [
    { m: '900001', marcado_em: HOJE, origem: 'Whatsapp', status: 'Aberta', conversa_id: 'c-1', nome: 'MARIA DE TESTE', tipo: 'proprio', conflito: ['cpf'], falta_no_klingo: ['email'], responsavel_diferente: [] },
    { m: '900002', marcado_em: HOJE, origem: 'Telefone', status: 'Aberta', conversa_id: 'c-2', nome: 'PEDRO DE TESTE', tipo: 'filho', conflito: ['nome'], falta_no_klingo: ['celular'], responsavel_diferente: ['cpf', 'email'] }],
  lista_ligadas: [
    { m: '900001', marcado_em: HOJE, origem: 'Whatsapp', ligacao: 'pedido', conversa_id: 'c-1', nome: 'MARIA DE TESTE', tipo: 'proprio', exame: 'atendido', status: 'Aberta', problema: true },
    { m: '900003', marcado_em: HOJE, origem: 'Whatsapp', ligacao: 'telefone_nome', conversa_id: 'c-3', nome: 'ANA DE TESTE', tipo: 'proprio', exame: 'agendado', status: 'Aberta', problema: false }],
  lista_sem_marcacao: [{ conversa_id: 'c-9', nome: 'JOSE DE TESTE', atualizado_em: `${HOJE}T12:00:00Z` }],
};
const AVISOS_CONF = [
  { id: 71, conversa_id: 'c-1', tipo: 'klingo_conflito', detalhe: { marcacoes: ['900001'], campos: ['cpf'], filho: false }, criado_em: `${HOJE}T15:00:00Z`, nome: 'MARIA DE TESTE' },
  { id: 72, conversa_id: 'c-2', tipo: 'klingo_dado_faltando', detalhe: { marcacoes: ['900002'], campos: ['celular'], filho: true }, criado_em: `${HOJE}T15:00:00Z`, nome: 'PEDRO DE TESTE' },
  { id: 73, conversa_id: 'c-4', tipo: 'klingo_dado_faltando', detalhe: { marcacoes: ['900004'], campos: ['celular', 'email'], filho: false }, criado_em: `${HOJE}T15:00:00Z`, nome: 'LUCIA DE TESTE' }];

async function pagina(browser, { semSql = false, admin = false, semAtend = false, conf = false, semPlat = false } = {}) {
  const eu = admin ? ADM : EU;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });   // cartões do topo somem em telas baixas (<= 820 px)
  await ctx.addInitScript(([id, token, email]) => {
    localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify({ access_token: token, refresh_token: 'x', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400,
      user: { id, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {} } }));
    try { localStorage.removeItem('painel.unidade'); } catch {}
  }, [eu.id, jwt(eu.id), eu.email]);
  const reg = { excecoes: [], rpcs: [] };
  const page = await ctx.newPage();
  page.on('pageerror', (e) => reg.excecoes.push(e.message));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
  await ctx.route('**/cdn.jsdelivr.net/npm/@supabase/supabase-js**', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(UMD) }));
  await ctx.route(`https://${HOST}/**`, async (rota) => {
    const req = rota.request();
    if (req.method() === 'OPTIONS') return rota.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url()); const p = url.pathname;
    const objeto = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
    let corpo; let status = 200;
    if (p.startsWith('/auth/v1/user')) corpo = { id: eu.id, aud: 'authenticated', role: 'authenticated', email: eu.email };
    else if (p.startsWith('/rest/v1/agentes')) corpo = url.searchParams.get('id') ? (objeto ? eu : [eu]) : [eu];
    else if (p.startsWith('/rest/v1/conversas')) corpo = CONVERSAS;
    else if (p.startsWith('/rest/v1/conversa_grupo')) corpo = GRUPOS;
    else if (p.endsWith('/rpc/painel_indicadores_atendentes')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['atendentes', b]); if (semAtend) { status = 404; corpo = { code: 'PGRST202', message: 'function not found' }; } else corpo = ATENDENTES(b); }
    else if (p.endsWith('/rpc/painel_indicadores_extras_v2')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['extras', b]); corpo = EXTRAS(admin); }
    else if (p.endsWith('/rpc/painel_indicadores_decisao')) {
      const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['decisao', b]);
      if (semSql) { status = 404; corpo = { code: 'PGRST202', message: 'Could not find the function public.painel_indicadores_decisao in the schema cache' }; } else corpo = DECISAO(b);
    }
    else if (p.endsWith('/rpc/painel_indicadores_plataforma')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['plataforma', b]); if (semPlat) { status = 404; corpo = { code: 'PGRST202', message: 'function not found' }; } else corpo = PLATAFORMA; }
    else if (p.endsWith('/rpc/painel_indicadores_mensal')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['mensal', b]); corpo = MENSAL; }
    else if (p.endsWith('/rpc/painel_indicadores_conferencia')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['conferencia', b]); corpo = conf ? CONFERENCIA : {}; }
    else if (p.endsWith('/rpc/paciente_avisos')) corpo = conf ? AVISOS_CONF : [];
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
const abaInd = async (t) => { await t.page.click('.nav button[data-aba=indicadores]'); await t.page.waitForSelector('.ind-kpis .ind-kpi'); };
const ultimo = (reg, k) => reg.rpcs.filter((r) => r[0] === k).at(-1)?.[1];

await caso('Cartões do topo: 5 conversas, 4 pessoas atendidas e 1 concluída hoje; a conversa de TESTE fica fora e não existe "Conversas por pessoa"', async () => {
  const { page, ctx, reg } = await abrir(); await esperaCartao(page, 'Pessoas atendidas hoje', '4');
  const k = await cartoes(page);
  await ctx.close();
  return { ok: k['Conversas hoje'] === '5' && k['Pessoas atendidas hoje'] === '4' && k['Concluídas hoje'] === '1' && !('Conversas por pessoa' in k) && !reg.excecoes.length, detalhe: JSON.stringify(k) + (reg.excecoes[0] ?? '') };
});
await caso('A conversa de teste aparece na lista com o selo "Teste"', async () => {
  const { page, ctx } = await abrir(); await esperaCartao(page, 'Pessoas atendidas hoje', '4');
  await page.click('.chip >> text=Abertas');
  await page.waitForSelector('.item');
  const selos = await page.locator('.item', { hasText: 'Teste da TI' }).locator('.urg').allInnerTexts();
  await ctx.close();
  return { ok: selos.includes('Teste'), detalhe: selos.join(',') };
});
await caso('Filtro de unidade Desenvoar vale para os cartões do topo (4 conversas, 3 pessoas atendidas, 1 concluída)', async () => {
  const { page, ctx } = await abrir(); await esperaCartao(page, 'Pessoas atendidas hoje', '4');
  await page.selectOption('#selUnidade', 'desenvoar'); await esperaCartao(page, 'Pessoas atendidas hoje', '3');
  const k = await cartoes(page); await ctx.close();
  return { ok: k['Conversas hoje'] === '4' && k['Concluídas hoje'] === '1', detalhe: JSON.stringify(k) };
});
await caso('Quadrado "Aguardando paciente" continua certo (1) e o filtro de unidade vale', async () => {
  const { page, ctx } = await abrir(); await esperaCartao(page, 'Aguardando paciente', '1');
  await page.selectOption('#selUnidade', 'csi'); await esperaCartao(page, 'Aguardando paciente', '0');
  await page.selectOption('#selUnidade', 'desenvoar'); await esperaCartao(page, 'Aguardando paciente', '1');
  await ctx.close(); return { ok: true };
});

const textoAba = async (t) => (await t.page.locator('.pagina').first().innerText()).replace(/\n+/g, ' ');
await caso('Aba Indicadores: período padrão é Hoje e pede só a consulta nova (uma chamada)', async () => {
  const t = await abrir(); await abaInd(t);
  const a = ultimo(t.reg, 'decisao'), ctrl = await t.page.locator('.ind-ctl input[type=date]').evaluateAll((l) => l.map((i) => i.value));
  await t.ctx.close();
  return { ok: a.p_de === HOJE && a.p_ate === HOJE && a.p_unidade === null && a.p_incluir_teste === false && ctrl.join() === `${HOJE},${HOJE}` && !t.reg.excecoes.length, detalhe: JSON.stringify(a) + (t.reg.excecoes[0] ?? '') };
});
await caso('Cartões do topo focados na plataforma: procuraram, agendaram, marcações (consultas e exames), canceladas e remarcadas, faltas', async () => {
  const t = await abrir(); await abaInd(t);
  const k = await t.page.locator('.ind-kpi').evaluateAll((l) => l.map((x) => ({ rot: x.querySelector('.ind-kpi-rot').textContent, v: x.querySelector('b').textContent, sub: x.querySelector('.ind-kpi-sub').textContent, d: x.querySelector('.ind-delta')?.textContent, c: x.querySelector('.ind-delta')?.className })));
  await t.ctx.close();
  const por = (r) => k.find((x) => x.rot === r) || {};
  return { ok: k.length === 5 && por('Pessoas que procuraram o chat').v === '60' && /▲ 20% vs período anterior/.test(por('Pessoas que procuraram o chat').d) && /bom/.test(por('Pessoas que procuraram o chat').c)
    && por('Agendaram pelo chat').v === '25%' && /▼ 15 pontos/.test(por('Agendaram pelo chat').d) && /ruim/.test(por('Agendaram pelo chat').c)
    && por('Marcações feitas pela plataforma').v === '134' && /122 consultas · 12 exames/.test(por('Marcações feitas pela plataforma').sub)
    && por('Canceladas e remarcadas').v === '12' && /5 canceladas · 7 remarcadas/.test(por('Canceladas e remarcadas').sub)
    && por('Faltas das marcações da plataforma').v === '15%' && /3 faltaram de 20/.test(por('Faltas das marcações da plataforma').sub), detalhe: JSON.stringify(k) };
});
await caso('"O que chama atenção": frases com os números certos, as piores primeiro', async () => {
  const t = await abrir(); await abaInd(t);
  const itens = await t.page.locator('.ind-destaques li').evaluateAll((l) => l.map((x) => [x.className, x.textContent]));
  await t.ctx.close();
  const todos = itens.map((x) => x[1]).join(' | ');
  return { ok: /Só 25% das pessoas que procuraram o chat agendaram \(15 de 60\)/.test(todos)
    && /maior perda é entre "Chegaram à escolha de data" e "Escolheram o horário": 18 pessoas \(45%\)/.test(todos)
    && /5 pessoas nunca foram respondidas por alguém da equipe/.test(todos)
    && /9% das marcações da plataforma foram canceladas ou remarcadas \(12 de 134\)/.test(todos)
    && /15% dos pacientes que a plataforma marcou faltaram \(3 de 20 atendimentos que já aconteceram\)/.test(todos)
    && /Das 559 consultas marcadas na clínica neste período, 122 \(21,8%\) vieram da plataforma/.test(todos) && /Das 2\.215 exames marcados na clínica neste período, 12 \(0,5%\) vieram da plataforma/.test(todos)
    && !/marcações novas caíram|Faltam mais/.test(todos) && itens[0][0] === 'ruim' && itens.length <= 7, detalhe: todos };
});
await caso('Funil: 6 passos, a maior perda marcada, e só uma maior perda', async () => {
  const t = await abrir(); await abaInd(t);
  const rots = await t.page.locator('.ind-painel').first().locator('.ind-rot').allInnerTexts();
  const fortes = await t.page.locator('.ind-perda.forte').allInnerTexts();
  const txt = await textoAba(t);
  await t.ctx.close();
  return { ok: rots.length === 6 && rots[0] === 'Procuraram o chat' && rots[5] === 'Agendaram' && fortes.length === 1 && /18 pessoas pararam aqui \(45%\) · maior perda/.test(fortes[0])
    && /Demora mediana para a primeira resposta da equipe: 20 min/.test(txt) && /Ninguém da equipe respondeu/.test(txt) && /Escolha de data e horário/.test(txt), detalhe: rots.join(',') + fortes.join('|') };
});
await caso('Faltas: painéis por confirmação, antecedência, unidade e tipo; o pior grupo fica em destaque (vermelho)', async () => {
  const t = await abrir(); await abaInd(t);
  const txt = await textoAba(t);
  const verm = await t.page.locator('.ind-trilho i.verm').count();
  const pior = await t.page.locator('.ind-linha.forte', { hasText: 'Não respondeu à confirmação' }).innerText();
  await t.ctx.close();
  return { ok: /Faltas por confirmação/.test(txt) && /Faltas por antecedência/.test(txt) && /Faltas por unidade/.test(txt) && /Faltas por tipo de atendimento/.test(txt)
    && /45,5% · 25 de 55/.test(pior.replace(/\n/g, ' ')) && verm >= 2 && /Motivos dos cancelamentos/.test(txt) && /Paciente pediu para cancelar/.test(txt), detalhe: pior.replace(/\n/g, ' ') + ' verm=' + verm };
});
await caso('Não sobrou a tabela "Por dia" nem os números antigos (reentradas, transferências, atravessaram a meia-noite)', async () => {
  const t = await abrir(); await abaInd(t);
  const txt = await textoAba(t); const tabelas = await t.page.locator('table:not(.ind-tab-graf)').count();   // a tabela do gráfico mensal é de propósito
  await t.ctx.close();
  return { ok: tabelas === 0 && !/reentradas|transferências|meia-noite|Conversas por pessoa|Confirmaram/i.test(txt), detalhe: txt.slice(0, 80) };
});
await caso('Atalhos de período: Ontem, 7 dias, 30 dias, Este mês e Mês anterior pedem as datas certas', async () => {
  const t = await abrir(); await abaInd(t);
  const [a, m] = HOJE.split('-').map(Number), p2 = (x) => String(x).padStart(2, '0');
  const esperado = { 'Ontem': [mais(HOJE, -1), mais(HOJE, -1)], 'Últimos 7 dias': [mais(HOJE, -6), HOJE], 'Últimos 30 dias': [mais(HOJE, -29), HOJE], 'Este mês': [`${a}-${p2(m)}-01`, HOJE],
    'Mês anterior': [new Date(Date.UTC(a, m - 2, 1)).toISOString().slice(0, 10), new Date(Date.UTC(a, m - 1, 0)).toISOString().slice(0, 10)] };
  const falhas = [];
  for (const [rot, [de, ate]] of Object.entries(esperado)) {
    await t.page.click(`.ind-atalhos .chip >> text=${rot}`);
    await t.page.waitForFunction(([r]) => document.querySelector('.ind-atalhos .chip[aria-pressed=true]')?.textContent === r, [rot]);
    await new Promise((r) => setTimeout(r, 250));
    const x = ultimo(t.reg, 'decisao'); if (x.p_de !== de || x.p_ate !== ate) falhas.push(`${rot}=${x.p_de}..${x.p_ate}`);
  }
  await t.ctx.close();
  return { ok: !falhas.length && !t.reg.excecoes.length, detalhe: falhas.join(' | ') };
});
await caso('Período livre: "Ver período" pede esse intervalo, datas invertidas são arrumadas e os atalhos soltam', async () => {
  const t = await abrir(); await abaInd(t);
  const d1 = mais(HOJE, -20), d2 = mais(HOJE, -10);
  await t.page.fill('.ind-ctl input[aria-label="Data inicial"]', d2); await t.page.fill('.ind-ctl input[aria-label="Data final"]', d1);   // invertido de propósito
  await t.page.click('.ind-ctl .btn >> text=Ver período');
  await t.page.waitForFunction(([x]) => document.querySelector('.pagina .sub')?.textContent.includes(x), [d1.split('-').reverse().join('/')]);
  const a = ultimo(t.reg, 'decisao'), aprox = await t.page.locator('.ind-atalhos .chip[aria-pressed=true]').count();
  await t.ctx.close();
  return { ok: a.p_de === d1 && a.p_ate === d2 && aprox === 0 && !t.reg.excecoes.length, detalhe: `${a.p_de}..${a.p_ate}` };
});
await caso('Período livre: mudar as duas datas carrega sozinho (sem clicar) e data futura avisa em vez de ser aceita em silêncio', async () => {
  const t = await abrir(); await abaInd(t);
  const d = mais(HOJE, -3), fut = mais(HOJE, 5);
  await t.page.fill('.ind-ctl input[aria-label="Data inicial"]', d); await t.page.fill('.ind-ctl input[aria-label="Data final"]', d);
  await t.page.waitForFunction(([x]) => document.querySelector('.pagina .sub')?.textContent.includes(x), [d.split('-').reverse().join('/')], { timeout: 4000 });
  const a = ultimo(t.reg, 'decisao');
  await t.page.fill('.ind-ctl input[aria-label="Data inicial"]', fut); await t.page.fill('.ind-ctl input[aria-label="Data final"]', fut);
  await t.page.click('.ind-ctl .btn >> text=Ver período'); await new Promise((r) => setTimeout(r, 1300));
  const aviso = await t.page.locator('.toast, #toast').first().innerText().catch(() => '');
  const futuras = t.reg.rpcs.filter((r) => r[0] === 'decisao' && (r[1].p_de > HOJE || r[1].p_ate > HOJE)).length;
  await t.ctx.close();
  return { ok: a.p_de === d && a.p_ate === d && futuras === 0 && /ainda não chegaram/.test(aviso) && !t.reg.excecoes.length, detalhe: `${a.p_de}..${a.p_ate} futuras=${futuras} ${aviso}` };
});
await caso('Filtro de unidade do topo vai para a consulta e os números mudam (60 → 40 pessoas)', async () => {
  const t = await abrir(); await abaInd(t);
  await t.page.selectOption('#selUnidade', 'desenvoar'); await t.page.waitForFunction(() => /Unidade Desenvoar/.test(document.querySelector('.pagina')?.innerText || ''));
  const v = await t.page.locator('.ind-kpi b').first().innerText();
  const un = ultimo(t.reg, 'decisao').p_unidade;
  await t.ctx.close();
  return { ok: v === '40' && un === 'desenvoar' && !t.reg.excecoes.length, detalhe: `${v} ${un}` };
});
await caso('Poucas pessoas (unidade com 4): avisa, não compara com base pequena e não escreve frases de funil', async () => {
  const t = await abrir(); await abaInd(t);
  await t.page.selectOption('#selUnidade', 'rmtc'); await t.page.waitForFunction(() => /Poucas pessoas neste período/.test(document.querySelector('.pagina')?.innerText || ''));
  const txt = await textoAba(t);
  await t.ctx.close();
  return { ok: /sem base para comparar/.test(txt) && !/das pessoas que procuraram o chat agendaram/.test(txt) && !t.reg.excecoes.length, detalhe: txt.slice(0, 160) };
});
await caso('"Incluir conversas de teste": só o administrador vê a caixa; marcar manda p_incluir_teste = true', async () => {
  const comum = await abrir(); await abaInd(comum);
  const vistaComum = await comum.page.locator('.ind-teste').count();
  await comum.ctx.close();
  const t = await abrir({ admin: true }); await abaInd(t);
  const vistaAdm = await t.page.locator('.ind-teste').count();
  await t.page.check('.ind-teste input'); await t.page.waitForFunction(() => document.querySelector('.ind-teste input')?.checked);
  await new Promise((r) => setTimeout(r, 300));
  const a = ultimo(t.reg, 'decisao');
  await t.ctx.close();
  return { ok: vistaComum === 0 && vistaAdm === 1 && a.p_incluir_teste === true, detalhe: `comum=${vistaComum} adm=${vistaAdm} ${a.p_incluir_teste}` };
});
await caso('Equipe: barras por atendente (conversas, agendamentos, nota) com o melhor em destaque e aviso de poucas avaliações', async () => {
  const t = await abrir(); await abaInd(t);
  const secao = t.page.locator('h3', { hasText: '4. Equipe' }); await secao.waitFor();
  const paineis = await t.page.locator('.ind-painel').evaluateAll((l) => l.map((p) => ({ tit: p.querySelector('h4').textContent, linhas: [...p.querySelectorAll('.ind-linha')].map((x) => x.innerText.replace(/\n/g, ' ')) })));
  const por = (t0) => paineis.find((x) => x.tit.startsWith(t0)) || { linhas: [] };
  const forte = await t.page.locator('.ind-linha.forte', { hasText: 'Ana' }).count();
  await t.ctx.close();
  return { ok: por('Conversas atendidas').linhas[0].startsWith('Ana') && /40/.test(por('Conversas atendidas').linhas[0]) && por('Agendamentos feitos').linhas.map((l) => l.split(' ')[0]).join() === 'Ana,Bia,Caio'
    && /9,4 · 8 aval\./.test(por('Nota média').linhas[0]) && /6,5 · 2 aval\. \(poucas\)/.test(por('Nota média').linhas[1]) && por('Nota média').linhas.length === 2 && forte >= 2
    && por('Quem respondeu primeiro').linhas[0].startsWith('Ana') && /30/.test(por('Quem respondeu primeiro').linhas[0])
    && por('Rapidez').linhas.map((l) => l.split(' ')[0]).join() === 'Ana,Caio,Bia' && /6 min · 30 conversas/.test(por('Rapidez').linhas[0]) && /45 min · 9 conversas/.test(por('Rapidez').linhas[2]), detalhe: JSON.stringify(paineis.slice(-3)) };
});
await caso('Avaliações dos pacientes voltaram: só o administrador vê; atendente comum não', async () => {
  const adm = await abrir({ admin: true }); await abaInd(adm);
  await adm.page.waitForFunction(() => /5\. Avaliações dos pacientes/.test(document.querySelector('.pagina')?.innerText || ''));
  const ta = await textoAba(adm); await adm.ctx.close();
  const c = await abrir(); await abaInd(c); await new Promise((r) => setTimeout(r, 300));
  const tc = await textoAba(c); await c.ctx.close();
  return { ok: /10 avaliações/.test(ta) && /8,5 nota do atendimento/.test(ta) && /5 pelo Instagram/.test(ta) && !/Avaliações dos pacientes/.test(tc) && /4\. Equipe/.test(tc) };
});
await caso('Sem o SQL dos atendentes, a parte da equipe avisa qual arquivo rodar e o resto da tela funciona', async () => {
  const t = await abrir({ semAtend: true }); await abaInd(t);
  const txt = await textoAba(t); await t.ctx.close();
  return { ok: /supabase\/indicadores-atendentes\.sql/.test(txt) && /por que não estão agendando/i.test(txt) && !t.reg.excecoes.length };
});
await caso('Sem o SQL novo no banco, mostra a mensagem com o arquivo a aplicar e não quebra', async () => {
  const t = await abrir({ semSql: true });
  await t.page.click('.nav button[data-aba=indicadores]'); await t.page.waitForSelector('.pagina .erro');
  const txt = await t.page.locator('.pagina').first().innerText();
  await t.ctx.close();
  return { ok: /supabase\/indicadores-decisao\.sql/.test(txt) && !t.reg.excecoes.length };
});

await caso('Seção 2 (plataforma): consultas e exames separados, total = canceladas + remarcadas + ativas, e as porcentagens', async () => {
  const t = await abrir({ conf: true }); await abaInd(t); await t.page.waitForSelector('h3:has-text("2. O que a plataforma marcou")');
  const a = ultimo(t.reg, 'plataforma');
  const linhas = await t.page.locator('.pagina table.ind-tab-graf').filter({ hasText: 'Remarcadas' }).first().locator('tbody tr').evaluateAll((l) => l.map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.trim())));
  await t.ctx.close();
  const por = (n) => linhas.find((l) => l[0].startsWith(n)) || [];
  const soma = (k) => Number(por(k)[1]) + Number(por(k)[2]) === Number(por(k)[3]);
  return { ok: a.p_de === HOJE && a.p_unidade === null && por('Marcações feitas')[1] === '122' && por('Marcações feitas')[2] === '12' && por('Marcações feitas')[3] === '134'
    && por('Canceladas').join() === 'Canceladas,4,1,5' && por('Remarcadas').join() === 'Remarcadas,5,2,7' && por('Ativas').join() === 'Ativas (seguem valendo),113,9,122'
    && soma('Marcações feitas') && soma('Canceladas') && soma('Remarcadas') && soma('Ativas') && 122 === 4 + 5 + 113 && 12 === 1 + 2 + 9
    && por('% canceladas ou remarcadas').join('|') === '% canceladas ou remarcadas|7,4%|25%|9%' && por('% de faltas').join('|') === '% de faltas (de quem já foi)|16,7%|0%|15%'
    && por('Parte do que a clínica').join('|') === 'Parte do que a clínica marcou no período|21,8%|0,5%|4,8%', detalhe: JSON.stringify(linhas) };
});
await caso('Funil por tipo: consultas e exames separados (começaram, escolheram data e horário, terminaram, agendaram)', async () => {
  const t = await abrir(); await abaInd(t);
  const painelTipo = t.page.locator('.ind-painel', { hasText: 'Funil por tipo' });
  const linhas = await painelTipo.locator('tbody tr').evaluateAll((l) => l.map((r) => [...r.querySelectorAll('td')].map((c) => c.innerText.trim()).join('|')));
  await t.ctx.close();
  return { ok: linhas.join(';') === 'Começaram o pedido|42|3;Chegaram à escolha de data|38|2;Escolheram o horário|21|1;Terminaram o pedido|19|1;Agendaram|14|1', detalhe: linhas.join(';') };
});
await caso('Seção 7 (clínica toda) só para comparar: separa consultas de exames e o gráfico mensal acompanha o botão', async () => {
  const t = await abrir(); await abaInd(t); await t.page.waitForSelector('.ind-clin .ind-graf svg');
  const lido = async () => ({ txt: (await t.page.locator('.ind-clin').innerText()).replace(/\n+/g, ' '), nov: (await t.page.locator('.ind-graf tbody tr').last().innerText()).replace(/\s+/g, ' ') });
  const todos = await lido();
  await t.page.locator('.ind-clin .chip', { hasText: 'Só consultas' }).click(); const co = await lido();
  await t.page.locator('.ind-clin .chip', { hasText: 'Só exames' }).click(); const ex = await lido();
  await t.ctx.close();
  return { ok: /300\s*consultas e exames no período/.test(todos.txt) && /5\.807/.test(todos.nov)
    && /90\s*consultas no período/.test(co.txt) && /Conta: 90 = 60 atendidos \+ 10 faltaram \+ 10 cancelados \+ 5 remarcados \+ 5 por vir/.test(co.txt) && /1\.546/.test(co.nov)
    && /210\s*exames no período/.test(ex.txt) && /Conta: 210 = 140 atendidos \+ 40 faltaram \+ 10 cancelados \+ 10 remarcados \+ 10 por vir/.test(ex.txt) && /4\.255/.test(ex.nov), detalhe: JSON.stringify({ a: todos.nov, b: co.nov, c: ex.nov }) };
});
await caso('Ordem das seções: 1 chat, 2 plataforma, 3 autoatendimento, 4 equipe, 5 avaliações (admin), 6 conferência, 7 clínica toda; observações no alto', async () => {
  const t = await abrir({ conf: true, admin: true }); await abaInd(t); await t.page.waitForSelector('.ind-clin');
  const tits = await t.page.locator('.pagina h3.ind-sec, .pagina summary.ind-sec-sum, .pagina .ind-destaques h3').allInnerTexts();
  await t.ctx.close();
  const n = tits.filter((x) => /^\d\.|^O que chama/.test(x)).map((x) => x.match(/^(\d)\./)?.[1] || 'obs');
  return { ok: n.join() === 'obs,1,2,3,4,5,6,7', detalhe: tits.join(' | ') };
});
await caso('Sem a função da plataforma no banco: os cartões da plataforma somem, a seção 2 avisa o arquivo e o resto funciona', async () => {
  const t = await abrir({ semPlat: true }); await abaInd(t);
  const txt = await textoAba(t); const cartoes = await t.page.locator('.ind-kpi').count(); await t.ctx.close();
  return { ok: cartoes === 2 && /supabase\/indicadores-plataforma\.sql/.test(txt) && /1\. Chat: por que não estão agendando/.test(txt) && !t.reg.excecoes.length, detalhe: String(cartoes) + (t.reg.excecoes[0] ?? '') };
});
await caso('Conferência Klingo x webchat: sem o SQL novo, a aba avisa em vez de mostrar números errados (e não quebra nada)', async () => {
  const t = await abrir(); await abaInd(t);
  const txt = await textoAba(t); await t.ctx.close();
  return { ok: /6\. Conferência Klingo × webchat/.test(txt) && /conferência ainda não está disponível/.test(txt) && !t.reg.excecoes.length, detalhe: t.reg.excecoes[0] ?? '' };
});
await caso('Conferência: pede o mesmo período e unidade dos outros blocos e mostra o total e as origens (WhatsApp, Telefone, Recepção, sem origem)', async () => {
  const t = await abrir({ conf: true }); await abaInd(t); await t.page.waitForSelector('.ind-conf-passo');
  const a = ultimo(t.reg, 'conferencia'), txt = await textoAba(t); await t.ctx.close();
  return { ok: a.p_de === HOJE && a.p_ate === HOJE && a.p_unidade === null && /200\s*marcações no Klingo/.test(txt) && /WhatsApp/.test(txt) && /Telefone/.test(txt) && /Recepção/.test(txt) && /Sem origem \(em branco no Klingo\)/.test(txt) && /45% · 90|90 · 45%/.test(txt) && !t.reg.excecoes.length, detalhe: JSON.stringify(a) + (t.reg.excecoes[0] ?? '') };
});
await caso('Gráfico mensal: 5 barras por mês (total, cancelados, remarcados, atendidos, faltaram), tabela com as porcentagens, escolher meses e esconder uma barra', async () => {
  const t = await abrir({ conf: true }); await abaInd(t); await t.page.waitForSelector('.ind-graf svg');
  const pedido = t.reg.rpcs.find((x) => x[0] === 'mensal');
  const barras = await t.page.locator('.ind-graf svg path').count(), leg = await t.page.locator('.ind-graf-leg button').allInnerTexts();
  const tab = (await t.page.locator('.ind-graf table').innerText()).replace(/\s+/g, ' ');
  await t.page.locator('.ind-graf-leg button', { hasText: 'Faltaram' }).click(); const barras4 = await t.page.locator('.ind-graf svg path').count();
  await t.page.locator('.ind-graf .chip', { hasText: '3 meses' }).click(); const linhas3 = await t.page.locator('.ind-graf tbody tr').count();
  await t.page.locator('.ind-graf svg .zona').last().hover(); const dica = await t.page.locator('.ind-graf-dica').innerText();
  if (process.env.FOTO_FULL) { await t.page.setViewportSize({ width: 1440, height: 4600 }); await t.page.evaluate(() => document.querySelectorAll('*').forEach((e) => { if (e.scrollTop > 0) e.scrollTop = 0; })); await t.page.waitForTimeout(400); } if (process.env.FOTO_FULL) await t.page.locator('.pagina').first().screenshot({ path: process.env.FOTO_GRAFICO }); else await t.page.screenshot({ path: process.env.FOTO_GRAFICO || '/tmp/grafico.png' });
  await t.ctx.close();
  return { ok: pedido && pedido[1].p_meses === 12 && barras === 10 && barras4 === 8 && leg.length === 5 && /Novembro de 2026 5\.807 663 11,4% 711 12,2% 2\.355 451 16,1% 1\.627/i.test(tab.replace('novembro','Novembro')) && linhas3 === 3 && /novembro de 2026/.test(dica) && /5\.807/.test(dica), detalhe: JSON.stringify({ barras, barras4, leg, linhas3 }) + ' ' + tab.slice(-230) };
});
await caso('Conferência: explica a divergência passo a passo (200 do Klingo, 30 fora do banco, 170 no banco, 10 remarcadas, 160 no cartão)', async () => {
  const t = await abrir({ conf: true }); await abaInd(t); await t.page.waitForSelector('.ind-conta');
  const conta = (await t.page.locator('.ind-conta').first().innerText()).replace(/\n+/g, ' | '); await t.ctx.close();
  return { ok: /Marcações no Klingo \| 200/.test(conta) && /depois de 30 dias[^|]*\| 30/.test(conta) && /já estão no banco \| 170/.test(conta) && /remarcadas \| 10/.test(conta) && /Marcações novas" do cartão \| 160/.test(conta), detalhe: conta };
});
await caso('Conferência: marcações com conversa no webchat (40), por pedido (25) e por celular e nome (15), e o que aconteceu com o exame', async () => {
  const t = await abrir({ conf: true }); await abaInd(t); await t.page.waitForSelector('.ind-conf-passo');
  const txt = await textoAba(t); await t.ctx.close();
  return { ok: /40\s*marcações com conversa no chat, total \(20% do Klingo\)/.test(txt) && /25\s*ligadas pelo pedido do chat/.test(txt) && /15\s*ligadas por celular e nome/.test(txt) && /160\s*sem conversa no chat/.test(txt)
    && /15\s*dessas, exame atendido/.test(txt) && /3\s*faltaram/.test(txt) && /18\s*por vir/.test(txt), detalhe: txt.slice(txt.indexOf('Quantas têm'), txt.indexOf('Quantas têm') + 300) };
});
await caso('Conferência: funil do webchat (60 procuraram, 52 atendidas pela equipe, 30 pedido pronto, 25 agendaram) e as 3 agendadas sem marcação no Klingo ficam à vista com o nome', async () => {
  const t = await abrir({ conf: true }); await abaInd(t); await t.page.waitForSelector('.ind-conf-passo');
  const txt = await textoAba(t); await t.ctx.close();
  return { ok: /60\s*pessoas procuraram o chat/.test(txt) && /52\s*tiveram resposta da equipe/.test(txt) && /30\s*chegaram ao pedido pronto/.test(txt) && /25\s*tiveram o pedido agendado/.test(txt)
    && /3\s*agendadas no chat, sem marcação no Klingo/.test(txt) && /Jose de Teste/i.test(txt), detalhe: '' };
});
await caso('Conferência: cadastro incompleto no Klingo (sem CPF 32%, sem e-mail 46%, sem celular 3%)', async () => {
  const t = await abrir({ conf: true }); await abaInd(t); await t.page.waitForSelector('.ind-conf-passo');
  const txt = await textoAba(t); await t.ctx.close();
  return { ok: /64\s*sem CPF \(32%\)/.test(txt) && /92\s*sem e-mail \(46%\)/.test(txt) && /6\s*sem celular nem telefone \(3%\)/.test(txt), detalhe: '' };
});
await caso('Conferência: tabela de problemas marcação por marcação; FILHO identificado, com CPF/e-mail do responsável tratados como esperados e sem pedir CPF', async () => {
  const t = await abrir({ conf: true }); await abaInd(t); await t.page.waitForSelector('.ind-tab');
  const linhas = await t.page.locator('.ind-tab', { hasText: 'O que fazer' }).first().locator('tbody tr').evaluateAll((l) => l.map((r) => r.innerText.replace(/\s+/g, ' ')));
  await t.ctx.close();
  const maria = linhas.find((x) => x.includes('900001')) || '', pedro = linhas.find((x) => x.includes('900002')) || '';
  return { ok: linhas.length === 2 && /Maria de Teste/i.test(maria) && /Próprio/.test(maria) && /discordam em CPF\./.test(maria) && /Falta no Klingo \(o chat tem\): e-mail/.test(maria)
    && /Filho\(a\)/.test(pedro) && /discordam em nome \(da criança\)/.test(pedro) && /não tem celular do responsável/.test(pedro) && !/CPF/.test(pedro), detalhe: pedro };
});
await caso('Conferência: "Conferir uma a uma" lista as marcações do webchat e diz qual tem aviso', async () => {
  const t = await abrir({ conf: true }); await abaInd(t); await t.page.waitForSelector('details.ind-como summary');
  await t.page.locator('details.ind-como summary', { hasText: 'Conferir uma a uma' }).click();
  const linhas = await t.page.locator('details.ind-como table tbody tr').evaluateAll((l) => l.map((r) => r.innerText.replace(/\s+/g, ' ')));
  await t.ctx.close();
  return { ok: linhas.length === 2 && /Pedido do chat/.test(linhas[0]) && /Atendido/.test(linhas[0]) && /Ver aviso/.test(linhas[0]) && /Celular e nome/.test(linhas[1]) && /Confere/.test(linhas[1]), detalhe: linhas.join(' || ') };
});
await caso('Avisos: conflito, dado faltando (adulto) e dado faltando de FILHO chegam como cartões na aba Avisos; no filho, o CPF do responsável não vai para a criança', async () => {
  const t = await abrir({ conf: true }); await t.page.click('.nav button[data-aba=avisos]'); await t.page.waitForSelector('#avisosPaciente .sug');
  const cartoes = await t.page.locator('#avisosPaciente .sug').evaluateAll((l) => l.map((c) => c.innerText.replace(/\s+/g, ' ')));
  await t.ctx.close();
  const conf = cartoes.find((x) => /Conflito entre o chat e o Klingo/.test(x)) || '', filho = cartoes.find((x) => /filho\(a\)/.test(x) && /Falta dado/.test(x)) || '', adulto = cartoes.find((x) => /Lucia/i.test(x)) || '';
  return { ok: cartoes.length === 3 && /CPF diferente/.test(conf) && /marcação 900001/.test(conf) && /do responsável e o Klingo está sem/.test(filho) && /Não coloque o CPF do responsável no cadastro da criança/.test(filho)
    && /celular e e-mail e o Klingo está sem\. Adicione no cadastro do Klingo/.test(adulto) && /Conferido/.test(conf), detalhe: cartoes.join(' || ') };
});


await browser.close(); srv.close();

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
