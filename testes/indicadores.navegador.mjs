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
      parou_em: { conversou: 15, exame: 2, plano: 1, preferencias: 0, data_hora: 18, dados: 2, pronto: 5 }, sem_agendar_motivo: { nao_respondido: 20, sem_equipe: 5, apenas_informacoes: 10, desistiu: 3, outro: 2, em_andamento: 5 }, espera_mediana_min: 20 },
    clinica: { novas_marcacoes: 200, novas_pelo_chat: 15, previstos: 300, atendidos: 200, faltaram: 50, cancelados: 20, remarcados: 15, por_vir: 15,
      falta_confirmacao: [{ nome: 'Confirmado', atendidos: 150, faltaram: 20 }, { nome: 'Sem Resposta', atendidos: 30, faltaram: 25 }],
      falta_antecedencia: [{ nome: 'No mesmo dia ou no dia seguinte', atendidos: 90, faltaram: 5 }, { nome: 'Mais de 15 dias antes', atendidos: 60, faltaram: 20 }],
      falta_unidade: [{ nome: 'CSI 1', atendidos: 120, faltaram: 30 }, { nome: 'CSI 2', atendidos: 80, faltaram: 20 }], falta_plano: [{ nome: 'Convênio', atendidos: 170, faltaram: 40 }, { nome: 'Particular', atendidos: 30, faltaram: 10 }],
      cancel_motivos: { paciente_cancelou: 9, erro_duplicidade: 6, sem_motivo: 3, convenio_cobertura: 2 } } };
  const anterior = { chat: { entraram: pequeno ? 3 : 50, funil: { entraram: pequeno ? 3 : 50, pedido: 40, data_hora: 35, horario: 28, completo: 25, agendaram: pequeno ? 1 : 20 }, parou_em: {}, sem_agendar_motivo: {}, espera_mediana_min: 8 },
    clinica: { novas_marcacoes: 250, novas_pelo_chat: 30, previstos: 300, atendidos: 220, faltaram: 30, cancelados: 10, remarcados: 10, por_vir: 30, falta_confirmacao: [], falta_antecedencia: [], falta_unidade: [], falta_plano: [], cancel_motivos: {} } };
  return { periodo: { de: a.p_de, ate: a.p_ate }, anterior_periodo: { de: mais(a.p_de, -1), ate: mais(a.p_de, -1) }, unidade: un, incluir_teste: !!a.p_incluir_teste, gerado_em: agora, atual, anterior };
};
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

async function pagina(browser, { semSql = false, admin = false } = {}) {
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
    else if (p.endsWith('/rpc/painel_indicadores_decisao')) {
      const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['decisao', b]);
      if (semSql) { status = 404; corpo = { code: 'PGRST202', message: 'Could not find the function public.painel_indicadores_decisao in the schema cache' }; } else corpo = DECISAO(b);
    }
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
  return { ok: a.p_de === HOJE && a.p_ate === HOJE && a.p_unidade === null && a.p_incluir_teste === false && ctrl.join() === `${HOJE},${HOJE}` && t.reg.rpcs.every((r) => r[0] === 'decisao') && !t.reg.excecoes.length, detalhe: JSON.stringify(a) + (t.reg.excecoes[0] ?? '') };
});
await caso('Quatro cartões, cada um comparado com o período anterior (taxa em pontos, contagem em %, falta subir é ruim)', async () => {
  const t = await abrir(); await abaInd(t);
  const k = await t.page.locator('.ind-kpi').evaluateAll((l) => l.map((x) => ({ rot: x.querySelector('.ind-kpi-rot').textContent, v: x.querySelector('b').textContent, d: x.querySelector('.ind-delta')?.textContent, c: x.querySelector('.ind-delta')?.className })));
  await t.ctx.close();
  const por = (r) => k.find((x) => x.rot === r) || {};
  return { ok: k.length === 4 && por('Pessoas que procuraram o chat').v === '60' && /▲ 20% vs período anterior/.test(por('Pessoas que procuraram o chat').d) && /bom/.test(por('Pessoas que procuraram o chat').c)
    && por('Agendaram pelo chat').v === '25%' && /▼ 15 pontos/.test(por('Agendaram pelo chat').d) && /ruim/.test(por('Agendaram pelo chat').c)
    && por('Marcações novas na clínica').v === '200' && /▼ 20%/.test(por('Marcações novas na clínica').d)
    && por('Faltas').v === '20%' && /▲ 8 pontos/.test(por('Faltas').d) && /ruim/.test(por('Faltas').c), detalhe: JSON.stringify(k) };
});
await caso('"O que chama atenção": frases com os números certos, as piores primeiro', async () => {
  const t = await abrir(); await abaInd(t);
  const itens = await t.page.locator('.ind-destaques li').evaluateAll((l) => l.map((x) => [x.className, x.textContent]));
  await t.ctx.close();
  const todos = itens.map((x) => x[1]).join(' | ');
  return { ok: /Só 25% das pessoas que procuraram o chat agendaram \(15 de 60\)/.test(todos)
    && /maior perda é entre "Chegaram à escolha de data" e "Escolheram o horário": 18 pessoas \(45%\)/.test(todos)
    && /5 pessoas nunca foram respondidas por alguém da equipe/.test(todos)
    && /Só 15 de 200 marcações novas \(7,5%\) vieram do chat/.test(todos) && /marcações novas caíram 20%/.test(todos)
    && /20% dos pacientes com exame marcado faltaram \(50 de 250\), subiu 8 ponto/.test(todos) && /confirmação "Não respondeu à confirmação" tem 45,5% de falta/.test(todos)
    && itens[0][0] === 'ruim' && itens.length <= 7, detalhe: todos };
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
  const txt = await textoAba(t); const tabelas = await t.page.locator('table').count();
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
await caso('Sem o SQL novo no banco, mostra a mensagem com o arquivo a aplicar e não quebra', async () => {
  const t = await abrir({ semSql: true });
  await t.page.click('.nav button[data-aba=indicadores]'); await t.page.waitForSelector('.pagina .erro');
  const txt = await t.page.locator('.pagina').first().innerText();
  await t.ctx.close();
  return { ok: /supabase\/indicadores-decisao\.sql/.test(txt) && !t.reg.excecoes.length };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
