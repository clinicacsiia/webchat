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
const PRINCIPAL = (a) => {
  const dias = []; for (let d = a.p_de; d <= a.p_ate; d = mais(d, 1)) dias.push(d);
  const pessoas = a.p_unidade === 'desenvoar' ? 3 : 4;
  return { periodo: { de: a.p_de, ate: a.p_ate, fechado_ate: a.p_fechado ?? null }, unidade: a.p_unidade, incluir_teste: !!a.p_incluir_teste, gerado_em: agora,
    pessoas: { unicas_no_periodo: pessoas + (a.p_incluir_teste ? 1 : 0), soma_dos_dias: pessoas + 2 }, reentradas: { total: 3, pessoas_que_voltaram: 2 },
    sem_atendimento_humano: { total: 2, ainda_sem_pessoa_agora: 1 },
    conclusoes: { total: 5, por_origem: { equipe: 4, inatividade: 1 }, por_motivo: { agendado: 2, nao_respondido: 1, desistiu: 1, sem_motivo: 1 }, cruzaram_meia_noite: 2, mais_de_24h: 1, reencerradas: 1 },
    transferencias: 0, agora: { aguardando: 1, em_atendimento: 3 }, testes: { conversas_criadas_no_periodo: 1 },
    por_dia: dias.map((d, i) => ({ dia: d, pessoas: 3 - i % 2, reentradas: 1, pessoas_que_voltaram: 1, sem_humano: 1, concluidas: 2, transferencias: 0, fechado: !!a.p_fechado && d <= a.p_fechado })) };
};
const CLINICA = (a) => ({ periodo: { de: a.p_de, ate: a.p_ate }, unidade: a.p_unidade, gerado_em: agora,
  total: { pessoas: 6, marcaram: 4, atendidos: 2, faltaram: 1, cancelaram_remarcaram: 1, por_vir: 1 },
  por_dia: [{ dia: a.p_ate, pessoas: 6, marcaram: 4, atendidos: 2, faltaram: 1, cancelaram_remarcaram: 1, por_vir: 1 }] });
const EXTRAS = (admin) => ({ por_hora: [{ hora: 9, conversas: 2 }, { hora: 10, conversas: 3 }],
  pedidos: { conversas_com_pedido_completo: 3, agendados: 3, agendados_pelo_sistema: 2, agendados_pela_equipe: 1, prontos_esperando_recepcao: 1, cancelados: 0, rascunhos: 4 }, avaliacoes: admin ? { total: 2, media_atendimento: 9, media_site: 8.5, por_canal: { Instagram: 2 } } : null });
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

async function pagina(browser, { semJornada = false, semSql = false, admin = false, fechado = null } = {}) {
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
    else if (p.endsWith('/rpc/painel_indicadores_jornada_v2')) {
      const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['jornada', b]);
      if (semJornada) { status = 404; corpo = { code: 'PGRST202', message: 'Could not find the function public.painel_indicadores_jornada_v2' }; } else corpo = CLINICA(b);
    }
    else if (p.endsWith('/rpc/painel_indicadores_extras_v2')) { const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['extras', b]); corpo = EXTRAS(admin); }
    else if (p.endsWith('/rpc/painel_indicadores_v2')) {
      const b = JSON.parse(req.postData() || '{}'); reg.rpcs.push(['principal', b]);
      if (semSql) { status = 404; corpo = { code: 'PGRST202', message: 'Could not find the function public.painel_indicadores_v2 in the schema cache' }; } else corpo = PRINCIPAL({ ...b, p_fechado: fechado });
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
const abaInd = async (t) => { await t.page.click('.nav button[data-aba=indicadores]'); await t.page.waitForSelector('.pagina .numeros .num'); };
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

await caso('Aba Indicadores: período padrão é Hoje (mesma data nos dois campos) e os cartões novos aparecem, sem "Conversas por pessoa (média)"', async () => {
  const t = await abrir(); await abaInd(t);
  const a = ultimo(t.reg, 'principal'), txt = await t.page.locator('.pagina').first().innerText();
  const ctrl = await t.page.locator('.ind-ctl input[type=date]').evaluateAll((l) => l.map((i) => i.value));
  await t.ctx.close();
  return { ok: a.p_de === HOJE && a.p_ate === HOJE && a.p_unidade === null && a.p_incluir_teste === false && ctrl.join() === `${HOJE},${HOJE}`
    && /pessoas atendidas/.test(txt) && /reentradas \(2 pessoas voltaram no mesmo dia\)/.test(txt) && /sem atendimento humano/.test(txt) && /concluídas \(pelo dia do encerramento\)/.test(txt) && /em andamento agora \(1 em espera\)/.test(txt)
    && !/conversas por pessoa/i.test(txt) && !/média/i.test(txt) && !t.reg.excecoes.length, detalhe: `${JSON.stringify(a)} ${t.reg.excecoes[0] ?? ''}` };
});
await caso('Atalhos de período: Ontem, 7 dias, 30 dias, Este mês e Mês anterior pedem as datas certas aos três relatórios', async () => {
  const t = await abrir(); await abaInd(t);
  const [a, m] = HOJE.split('-').map(Number), p2 = (x) => String(x).padStart(2, '0');
  const esperado = { 'Ontem': [mais(HOJE, -1), mais(HOJE, -1)], 'Últimos 7 dias': [mais(HOJE, -6), HOJE], 'Últimos 30 dias': [mais(HOJE, -29), HOJE], 'Este mês': [`${a}-${p2(m)}-01`, HOJE],
    'Mês anterior': [new Date(Date.UTC(a, m - 2, 1)).toISOString().slice(0, 10), new Date(Date.UTC(a, m - 1, 0)).toISOString().slice(0, 10)] };
  const falhas = [];
  for (const [rot, [de, ate]] of Object.entries(esperado)) {
    await t.page.click(`.ind-atalhos .chip >> text=${rot}`);
    await t.page.waitForFunction(([r]) => document.querySelector('.ind-atalhos .chip[aria-pressed=true]')?.textContent === r, [rot]);
    await new Promise((r) => setTimeout(r, 250));
    for (const k of ['principal', 'jornada', 'extras']) { const x = ultimo(t.reg, k); if (x.p_de !== de || x.p_ate !== ate) falhas.push(`${rot}/${k}=${x.p_de}..${x.p_ate}`); }
  }
  await t.ctx.close();
  return { ok: !falhas.length && !t.reg.excecoes.length, detalhe: falhas.join(' | ') };
});
await caso('Período livre: escolher as datas e "Ver período" pede exatamente esse intervalo; datas invertidas são arrumadas; um dia só = mesma data nos dois campos', async () => {
  const t = await abrir(); await abaInd(t);
  const d1 = mais(HOJE, -20), d2 = mais(HOJE, -10);
  await t.page.fill('.ind-ctl input[aria-label="Data inicial"]', d2); await t.page.fill('.ind-ctl input[aria-label="Data final"]', d1);   // invertido de propósito
  await t.page.click('.ind-ctl .btn >> text=Ver período');
  await t.page.waitForFunction(([x]) => document.querySelector('.pagina .sub')?.textContent.includes(x), [d1.split('-').reverse().join('/')]);
  const a = ultimo(t.reg, 'principal'), linhas = await t.page.locator('tbody tr').count();
  const aprox = await t.page.locator('.ind-atalhos .chip[aria-pressed=true]').count();
  await t.page.fill('.ind-ctl input[aria-label="Data inicial"]', d1); await t.page.fill('.ind-ctl input[aria-label="Data final"]', d1);
  await t.page.click('.ind-ctl .btn >> text=Ver período');
  await t.page.waitForFunction(() => /Período: \d{2}\/\d{2}\/\d{4}\. /.test(document.querySelector('.pagina .sub')?.textContent || ''));
  const b = ultimo(t.reg, 'principal');
  await t.ctx.close();
  return { ok: a.p_de === d1 && a.p_ate === d2 && linhas === 12 && aprox === 0 && b.p_de === d1 && b.p_ate === d1 && !t.reg.excecoes.length, detalhe: `${a.p_de}..${a.p_ate} linhas=${linhas} | ${b.p_de}..${b.p_ate}` };
});
await caso('Filtro de unidade do topo vai para as três consultas e o cartão muda (4 → 3 pessoas atendidas)', async () => {
  const t = await abrir(); await abaInd(t);
  const antes = await t.page.locator('.numeros .num').first().innerText();
  await t.page.selectOption('#selUnidade', 'desenvoar'); await t.page.waitForFunction(() => /Unidade Desenvoar/.test(document.querySelector('.pagina')?.innerText || ''));
  const depois = await t.page.locator('.numeros .num').first().innerText();
  const un = ['principal', 'jornada', 'extras'].map((k) => ultimo(t.reg, k).p_unidade);
  await t.ctx.close();
  return { ok: /^4\s/.test(antes) && /^3\s/.test(depois) && un.every((u) => u === 'desenvoar') && !t.reg.excecoes.length, detalhe: `${antes.replace(/\n/g, ' ')} -> ${depois.replace(/\n/g, ' ')} ${un}` };
});
await caso('"Incluir conversas de teste": só o administrador vê a caixa; marcar manda p_incluir_teste = true e o número sobe', async () => {
  const comum = await abrir(); await abaInd(comum);
  const vistaComum = await comum.page.locator('.ind-teste').count();
  await comum.ctx.close();
  const t = await abrir({ admin: true }); await abaInd(t);
  const vistaAdm = await t.page.locator('.ind-teste').count();
  const sem = (await t.page.locator('.numeros .num').first().innerText()).split('\n')[0];
  await t.page.check('.ind-teste input'); await t.page.waitForFunction(() => document.querySelector('.numeros .num b')?.textContent === '5');
  const a = ultimo(t.reg, 'principal');
  await t.ctx.close();
  return { ok: vistaComum === 0 && vistaAdm === 1 && sem === '4' && a.p_incluir_teste === true, detalhe: `comum=${vistaComum} adm=${vistaAdm} ${sem} -> ${a.p_incluir_teste}` };
});
await caso('Tabela "Por dia": sem "Conversas por pessoa" e sem "Confirmaram"; com o total do período e a parte da clínica', async () => {
  const t = await abrir(); await abaInd(t);
  await t.page.click('.ind-atalhos .chip >> text=Últimos 7 dias'); await t.page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 8);
  const cab = (await t.page.locator('thead tr').nth(1).locator('th').allInnerTexts()).map((x) => x.trim());
  const linhas = await t.page.locator('tbody tr').evaluateAll((l) => l.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent.trim())));
  const txt = await t.page.locator('.pagina').first().innerText();
  await t.ctx.close();
  const esperado = ['Pessoas atendidas', 'Reentradas', 'Sem atendimento humano', 'Concluídas', 'Transferências', 'Pessoas novas', 'Marcaram', 'Atendidos', 'Faltaram', 'Cancelaram ou remarcaram', 'Ainda por vir'];
  return { ok: JSON.stringify(cab) === JSON.stringify(esperado) && !/Confirmaram/.test(txt) && !/Conversas por pessoa/.test(txt) && linhas[0][0] === 'Total do período' && linhas[0].slice(1, 6).join() === '4,3,2,5,0'
    && linhas[0].slice(6).join() === '6,4,2,1,1,1', detalhe: `${cab} | ${JSON.stringify(linhas[0])}` };
});
await caso('Sem o SQL da clínica no banco, a tabela mostra só o chat (5 colunas) e sem erro', async () => {
  const t = await abrir({ semJornada: true }); await abaInd(t);
  const cab = (await t.page.locator('thead tr').nth(1).locator('th').allInnerTexts()).map((x) => x.trim());
  const txt = await t.page.locator('.pagina').first().innerText();
  await t.ctx.close();
  return { ok: cab.length === 5 && !/Na clínica: do agendamento/.test(txt) && !t.reg.excecoes.length, detalhe: `${cab} ${t.reg.excecoes[0] ?? ''}` };
});
await caso('Sem o SQL novo no banco, mostra a mensagem com o arquivo a aplicar e não quebra', async () => {
  const t = await abrir({ semSql: true });
  await t.page.click('.nav button[data-aba=indicadores]'); await t.page.waitForSelector('.pagina .erro');
  const txt = await t.page.locator('.pagina').first().innerText();
  await t.ctx.close();
  return { ok: /supabase\/indicadores-v2\.sql/.test(txt) && !t.reg.excecoes.length };
});
await caso('Dia fechado: aparece "fechado" na linha e o texto avisa até quando os números não mudam; sem fechamento, avisa que ainda podem mudar', async () => {
  const f = await abrir({ fechado: mais(HOJE, -1) }); await abaInd(f);
  await f.page.click('.ind-atalhos .chip >> text=Últimos 7 dias'); await f.page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 8);
  const marcados = await f.page.locator('tbody tr small', { hasText: 'fechado' }).count();
  const txtF = await f.page.locator('.pagina').first().innerText();
  await f.ctx.close();
  const n = await abrir(); await abaInd(n);
  const txtN = await n.page.locator('.pagina').first().innerText();
  await n.ctx.close();
  return { ok: marcados === 6 && new RegExp(`Dias fechados até ${mais(HOJE, -1).split('-').reverse().join('/')}`).test(txtF) && /Nenhum dia foi fechado ainda/.test(txtN), detalhe: `marcados=${marcados}` };
});
await caso('Gráfico por horário e avaliações (só administrador) aparecem; atendente comum não vê as avaliações', async () => {
  const adm = await abrir({ admin: true }); await abaInd(adm);
  await adm.page.waitForFunction(() => /Avaliações dos pacientes/.test(document.querySelector('.pagina')?.innerText || ''));
  const barras = await adm.page.locator('.barras-h .bh').count();
  await adm.ctx.close();
  const comum = await abrir(); await abaInd(comum);
  await new Promise((r) => setTimeout(r, 300));
  const txt = await comum.page.locator('.pagina').first().innerText();
  await comum.ctx.close();
  return { ok: barras === 2 && !/Avaliações dos pacientes/.test(txt) };
});
await caso('Pedidos e agendamentos: agendados separados em "pelo sistema" e "pela atendente"', async () => {
  const t = await abrir(); await abaInd(t);
  await t.page.waitForFunction(() => /Pedidos e agendamentos/.test(document.querySelector('.pagina')?.innerText || ''));
  const txt = (await t.page.locator('.pagina').first().innerText()).replace(/\n+/g, ' ');
  await t.ctx.close();
  return { ok: /agendados \(2 pelo sistema · 1 pela atendente\)/.test(txt) && /1 prontos, esperando a recepção marcar/.test(txt) && /4 pedidos não terminados/.test(txt), detalhe: txt.slice(0, 120) };
});
await caso('Motivos de encerramento e conclusões (atravessaram a meia-noite, mais de 24 h, inatividade) aparecem com os números do banco', async () => {
  const t = await abrir(); await abaInd(t);
  const txt = (await t.page.locator('.pagina').first().innerText()).replace(/\n+/g, ' ');
  await t.ctx.close();
  return { ok: /2 atravessaram a meia-noite/.test(txt) && /1 duraram mais de 24 h/.test(txt) && /1 fechadas de novo depois de reabertas/.test(txt) && /1 encerradas por inatividade/.test(txt) && /2 Agendado/.test(txt) && /1 sem motivo registrado/.test(txt), detalhe: txt.slice(0, 80) };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
