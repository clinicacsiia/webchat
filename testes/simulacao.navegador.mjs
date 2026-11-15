// FLUXOGRAMA: entrada (a página /simulacao/ servida localmente + Supabase simulado: login, painel_simulacao_dia e painel_simulacao_indicadores com dados inventados) -> validação (demonstração sem login; login pela tela; carregamento do dia real, recomendações, painéis de indicadores, teste de encaixe, premissas, capacidade salva; nada além das duas funções é chamado; celular sem rolagem lateral) -> saída (PASS/FAIL por verificação; código de saída 1 se algo falhar)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial
// Não substitui o teste com o Supabase real (o banco tem teste próprio: sql-simulacao.test.mjs).
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
const TIPOS = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp' };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const USER = { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'a@teste.local' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: USER.id, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })}.x`;
const sessao = () => ({ access_token: jwt(), refresh_token: 'r', token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, user: USER });
const Q = [-40, -30, -20, -14, -10, -6, -3, 0, 6, 15, 25];

const THREE_DIR = resolve(import.meta.dirname, 'node_modules/three');
const EXTERNA = JSON.parse(require('node:fs').readFileSync(resolve(RAIZ, 'simulacao/examples/externa.json'), 'utf8'));
const LACUNAS = JSON.parse(require('node:fs').readFileSync(resolve(RAIZ, 'simulacao/examples/lacunas.json'), 'utf8'));
const DECISAO = JSON.parse(require('node:fs').readFileSync(resolve(RAIZ, 'simulacao/examples/decisao.json'), 'utf8'));
const ARGS_GL = ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

// ---------------- dados inventados no formato do banco ----------------
const hojeSP = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());
const minutoSP = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Bahia', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value])); return Number(p.hour) * 60 + Number(p.minute); };
function dia(date) {
  const hoje = hojeSP();
  const corte = date < hoje ? 1439 : date > hoje ? 0 : minutoSP();
  const asOf = date < hoje ? new Date(new Date(`${date}T09:00:00Z`).getTime() + 86400000).toISOString() : new Date().toISOString(); // dia fechado: 06:00 do dia seguinte em Salvador, como no banco
  const visits = [];
  let id = 0;
  const unidades = [['csi1', 'us', 60], ['csi1', 'consulta', 24], ['csi2', 'rm', 40], ['csi2', 'tc', 8], ['ped', 'consulta', 36]];
  for (const [unit, type, n] of unidades) {
    for (let i = 0; i < n; i++) {
      id++;
      const slot = 8 * 60 + Math.floor(i * (600 / n)) + (i % 2) * 5;
      const v = { id, person: id, unit, type, slot, confirm: ['confirmado', 'confirmado', 'a_confirmar', 'sem_resposta'][i % 4] };
      if (slot + 15 <= corte && i % 6 === 5) v.absentAt = slot + 15;
      else if (slot - 8 <= corte) { v.arrive = slot - 8 + (i % 7); v.done = true; v.start = v.arrive + 8 + (i % 5); v.end = v.start + 20; }
      if (v.arrive > corte) { delete v.arrive; delete v.done; delete v.start; delete v.end; }
      else if (v.end > corte) { delete v.end; }
      visits.push(v);
    }
  }
  const history = [];
  for (const d of ['2026-11-03', '2026-11-04', '2026-11-05']) for (const h of [8, 9, 10, 11, 14, 15]) history.push({ date: d, hour: h, unit: 'csi1', type: 'us', booked: 6, arrivals: 5 });
  return {
    date, asOf, visits, history, capacity: {}, outage: null,
    calibragem: { faltaPorConfirmacao: { confirmado: { taxa: 11, n: 300 }, a_confirmar: { taxa: 35, n: 60 }, sem_resposta: { taxa: 54, n: 80 } }, faltaGeral: 17, chegada: { csi1: { n: 300, quantis: Q }, csi2: { n: 200, quantis: Q.map((x) => x - 5) } } },
    meta: { marcacoes_no_dia: visits.length + 12, canceladas_ou_remarcadas: 12, fora_do_modelo: 0, com_chegada_real: visits.filter((v) => v.arrive !== undefined).length, faltas_registradas: visits.filter((v) => v.absentAt !== undefined).length, sync_klingo_em: new Date().toISOString() },
  };
}
const INDICADORES = {
  periodo: { de: '2026-10-18', ate: '2026-11-14', dias: 28, dias_com_dado: 15, primeiro_dia_do_banco: '2026-10-30' },
  unidades: [{ unidade: 'csi1', marcadas: 1000, atendidas: 800, faltaram: 120, canceladas: 50, remarcadas: 30, pct_falta: 13, pct_cancela_remarca: 8 }, { unidade: 'csi2', marcadas: 500, atendidas: 400, faltaram: 60, canceladas: 20, remarcadas: 20, pct_falta: 13, pct_cancela_remarca: 8 }],
  modalidades: [{ unidade: 'csi1', tipo: 'us', n: 500, dias: 13, por_dia: 38, pct_falta: 12 }, { unidade: 'csi2', tipo: 'rm', n: 400, dias: 14, por_dia: 28, pct_falta: 14 }],
  confirmacao: [{ situacao: 'Confirmado', n: 2413, faltaram: 275, pct_falta: 11.4 }, { situacao: 'Sem Resposta', n: 329, faltaram: 174, pct_falta: 52.9 }, { situacao: 'A Confirmar', n: 172, faltaram: 57, pct_falta: 33.1 }],
  semana: [{ dow: 1, unidade: 'csi1', media_por_dia: 60, dias: 2, pct_falta: 12 }, { dow: 2, unidade: 'csi2', media_por_dia: 40, dias: 2, pct_falta: 15 }],
  horas: [{ hora: 8, unidade: 'csi1', media_por_dia: 10, pct_falta: 18, dias: 13 }, { hora: 9, unidade: 'csi2', media_por_dia: 6, pct_falta: 9, dias: 13 }],
  pontualidade: [{ unidade: 'csi1', n: 300, p10: -40, p50: -6, p90: 25, pct_15_antes: 32, pct_15_depois: 12 }],
  antecedencia: { n: 3669, p50_dias: 7.1, p90_dias: 29.8, pct_menos_de_1_dia: 16.7 },
  proximos: [{ dia: hojeSP(), unidade: 'csi1', marcadas: 80, confirmadas: 50, a_confirmar: 10, sem_resposta: 20, faltas_esperadas: 14.2 }],
  origem: [{ origem: 'Whatsapp', n: 1124, do_chat: 80 }, { origem: 'sem_origem', n: 594, do_chat: 0 }],
  pedidos_chat: [{ situacao: 'novo', n: 12 }], fila_chegada: { n: 5, atendidos: 5, espera_mediana_min: 0.8 },
};

function servidor() {
  return new Promise((ok) => {
    const s = createServer(async (req, res) => {
      const c = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      let a = join(RAIZ, c); if (existsSync(a) && !extname(a)) a = join(a, 'index.html');
      if (!existsSync(a)) { res.writeHead(404); res.end('x'); return; }
      res.writeHead(200, { 'content-type': TIPOS[extname(a)] ?? 'application/octet-stream' }); res.end(await readFile(a));
    }).listen(0, '127.0.0.1', () => ok(s));
  });
}

async function pagina(browser, { logado }, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const chamadas = [];
  const erros = [];
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push(m.text()); });
  await p.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: require('node:fs').readFileSync(UMD, 'utf8') }));
  await p.route('https://cdn.jsdelivr.net/npm/three@0.160.0/**', (r) => {
    const rel = new URL(r.request().url()).pathname.replace('/npm/three@0.160.0/', '');
    const arq = join(THREE_DIR, rel);
    return existsSync(arq) ? r.fulfill({ status: 200, contentType: 'text/javascript', body: require('node:fs').readFileSync(arq, 'utf8') }) : r.fulfill({ status: 404, body: 'x' });
  });
  await p.route(`https://${HOST}/**`, async (r) => {
    const req = r.request(), u = new URL(req.url());
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    const json = (body, status = 200) => r.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (u.pathname === '/auth/v1/token') return json(sessao());
    if (u.pathname === '/auth/v1/user') return json(USER);
    const fn = u.pathname.replace('/rest/v1/rpc/', '');
    const corpo = req.postData() ? JSON.parse(req.postData()) : {};
    chamadas.push({ fn, corpo });
    if (fn === 'painel_simulacao_dia') return json(dia(corpo.p_dia));
    if (fn === 'painel_simulacao_indicadores') return json(INDICADORES);
    if (fn === 'painel_simulacao_externa') return json({ ...EXTERNA, gerado_em: new Date().toISOString() });
    if (fn === 'painel_indicadores_decisao') return json(DECISAO);
    if (fn === 'painel_simulacao_lacunas') return json(LACUNAS);
    return json({ message: 'não esperado: ' + fn }, 404);
  });
  if (logado) await p.addInitScript((s) => { localStorage.setItem('sb-nrvuynjwcgwpjdptkiay-auth-token', JSON.stringify(s)); }, sessao());
  return { p, ctx, chamadas, erros };
}
const texto = (p, sel) => p.locator(sel).first().innerText();
const texto_ = texto;
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await servidor();
const URL_BASE = `http://127.0.0.1:${srv.address().port}/simulacao/`;
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ARGS_GL } : {});

// 1. Sem login, a demonstração funciona e não chama o banco
await caso('sem login: abre a demonstração, mostra métricas e não chama nenhuma função', async () => {
  const { p, chamadas, erros, ctx } = await pagina(browser, { logado: false });
  await p.goto(URL_BASE); await p.waitForSelector('#metrics .metric');
  await espera(400);
  const ok = (await p.locator('#metrics .metric').count()) >= 4 && chamadas.length === 0 && erros.length === 0 && (await texto(p, '#sourceStatus')).includes('Demonstração');
  const recs = await p.locator('#recommendations li').count();
  await ctx.close();
  return { ok: ok && recs >= 1, detalhe: `métricas ok, ${recs} recomendação(ões), chamadas ${chamadas.length}, erros ${erros.join('|')}` };
});

// 2. Pedir os dados reais sem login mostra o formulário; entrar carrega o dia
await caso('sem login, escolher Klingo + banco pede o login; entrar carrega o dia de hoje', async () => {
  const { p, chamadas, erros, ctx } = await pagina(browser, { logado: false });
  await p.goto(URL_BASE); await p.waitForSelector('#metrics .metric');
  await p.selectOption('#dataMode', 'forecast');
  await p.waitForSelector('#loginCard:not([hidden])');
  const antes = chamadas.length;
  await p.fill('#loginEmail', 'a@teste.local'); await p.fill('#loginPassword', 'senha-de-teste');
  await p.click('#loginForm button[type=submit]');
  await p.waitForFunction(() => document.getElementById('sourceStatus').textContent.includes('#14359'), null, { timeout: 15000 });
  const ok = antes === 0 && chamadas.some((c) => c.fn === 'painel_simulacao_dia') && (await p.locator('#loginCard').isHidden());
  await ctx.close();
  return { ok: ok && !erros.length, detalhe: `chamadas ${chamadas.map((c) => c.fn).join(',')}; erros ${erros.join('|')}` };
});

// 3. Com sessão, abre direto nos dados reais
const logada = await pagina(browser, { logado: true });
await logada.p.goto(URL_BASE);
await logada.p.waitForFunction(() => document.getElementById('sourceStatus').textContent.includes('#14359'), null, { timeout: 15000 });
await logada.p.waitForSelector('#recommendations li', { timeout: 15000 });
await espera(500);
const P = logada.p;

await caso('com sessão: carrega hoje sozinho, mostra origem do dado, chegadas reais, faltas e histórico', async () => {
  const s = await texto(P, '#sourceStatus');
  const modo = await P.inputValue('#dataMode');
  return { ok: modo === 'forecast' && /chegada\(s\) real/.test(s) && /falta\(s\) registrada/.test(s) && /dia\(s\) de histórico/.test(s) && /cancelada\(s\)\/remarcada\(s\)/.test(s), detalhe: s.slice(0, 260) };
});
await caso('chama só as funções de leitura previstas, só com datas, dias e filtros fixos (nenhum dado pessoal sai)', async () => {
  const fns = [...new Set(logada.chamadas.map((c) => c.fn))].sort();
  const chaves = [...new Set(logada.chamadas.flatMap((c) => Object.keys(c.corpo)))].sort();
  return { ok: fns.join() === 'painel_indicadores_decisao,painel_simulacao_dia,painel_simulacao_externa,painel_simulacao_indicadores,painel_simulacao_lacunas' && chaves.join() === 'p_ate,p_de,p_dia,p_dias,p_incluir_teste,p_unidade', detalhe: fns.join() + ' / ' + chaves.join() };
});
await caso('hoje: segue a hora atual e a linha do tempo tem dados', async () => {
  const pressed = await P.getAttribute('#live', 'aria-pressed');
  const occ = await texto(P, '#occupancy');
  return { ok: pressed === 'true' && occ.length > 0, detalhe: `live ${pressed}; ${occ}` };
});
await caso('Indi no lugar dos cartões: não há cartões nem lista de indicadores na tela; a Indi oferece os 4 indicadores do painel e os problemas, do mais grave ao menos grave', async () => {
  const antigos = await P.locator('#kpis, #attention, #strip, .kpi, .space').count();
  const grupos = await P.locator('#indiAssuntos h4').allInnerTexts();
  const niveis = await P.locator('#indiAssuntos [data-assunto][data-level]').evaluateAll((els) => els.map((e) => e.dataset.level));
  const ids = await P.evaluate(() => window.__simulacao.assuntos());
  const rank = { critical: 0, serious: 1, warning: 2 };
  const problemas = niveis.slice(4);
  const ordenado = problemas.every((n, i) => i === 0 || rank[problemas[i - 1]] <= rank[n]);
  const foto = await P.evaluate(() => getComputedStyle(document.querySelector('.indi-foto')).backgroundImage);
  return { ok: antigos === 0 && grupos.length === 2 && ids.slice(0, 4).join() === 'cartao-entraram,cartao-agendaram,cartao-novas,cartao-faltas' && problemas.length >= 3 && ordenado && /resident-portraits/.test(foto), detalhe: `${antigos} cartões antigos; grupos ${grupos.join(' | ')}; níveis ${niveis.join(',')}` };
});
await caso('clicar num assunto: a Indi explica em 4 partes e marca só aquele assunto', async () => {
  await P.locator('#indiAssuntos [data-assunto="etapa-confirmar"]').click();
  const partes = await P.locator('#indiFala dt').allInnerTexts();
  const marcados = await P.locator('#indiAssuntos [aria-pressed="true"]').count();
  const fala = await texto(P, '#indiFala');
  return { ok: partes.join().toLowerCase() === 'o que é,como está agora,por que importa,o que eu faria' && marcados === 1 && /confirm/i.test(fala) && !/undefined|NaN/.test(fala), detalhe: `${partes.join('|')}; ${marcados} marcado(s)` };
});
await caso('clicar na Indi (faltas): ela vai ao local, a simulação volta 20 min antes e para na hora exata da falta, e o balão e a legenda mostram o problema', async () => {
  await P.locator('#indiAssuntos [data-assunto="cartao-faltas"]').click();
  await P.locator('#indiAvatar').click();
  const v = await P.evaluate(() => window.__simulacao.indi());
  const unidadeNaTela = await P.inputValue('#sceneUnit');
  const legenda = await texto(P, '#indiLegenda');
  const relogioIni = await texto(P, '#clock');
  await P.waitForFunction(() => window.__simulacao.indi()?.naHora === true, null, { timeout: 30000 });
  await espera(900);
  const fim = await P.evaluate(() => window.__simulacao.indi());
  const relogioFim = await texto(P, '#clock');
  const bolha = await P.locator('#scenes [data-unit="' + v.unidade + '"] .indi-bubble').innerText();
  const legendaFim = await texto(P, '#indiLegenda');
  const horaTxt = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  return { ok: v.exata === true && v.minuto - v.inicio <= 20 && v.minuto > v.inicio && unidadeNaTela === v.unidade && /Indi está em/.test(legenda) && relogioIni.startsWith(horaTxt(v.inicio).slice(0, 4)) && fim.chegou && fim.tempo === v.minuto && relogioFim.startsWith(horaTxt(v.minuto)) && /não vieram/.test(bolha) && /não vieram/.test(legendaFim),
    detalhe: JSON.stringify({ v, relogioIni, relogioFim, bolha: bolha.slice(0, 90) }) };
});
await caso('clicar na Indi (chat): sem hora registrada ela NÃO inventa horário: vai à recepção, não mexe no relógio e explica por quê', async () => {
  await P.locator('#indiVoltar').click();
  await P.locator('#indiAssuntos [data-assunto="etapa-chat"]').click();
  const antes = await texto(P, '#clock');
  await P.locator('#indiAvatar').click();
  await espera(300);
  const v = await P.evaluate(() => window.__simulacao.indi());
  const depois = await texto(P, '#clock');
  await P.waitForFunction(() => window.__simulacao.indi()?.chegou === true, null, { timeout: 15000 });
  const bolha = await P.locator('#scenes [data-unit="' + v.unidade + '"] .indi-bubble').innerText();
  const legenda = await texto(P, '#indiLegenda');
  return { ok: v.exata === false && v.minuto === null && v.sala === 'reception' && antes === depois && /não invento um horário/.test(bolha) && /não invento um horário/.test(legenda), detalhe: JSON.stringify({ v, antes, depois, bolha: bolha.slice(0, 80) }) };
});
await caso('clicar na Indi (fila): vai à hora do maior pico de fila, e "Encerrar visita" limpa tudo', async () => {
  await P.locator('#indiAssuntos [data-assunto="etapa-clinica"]').click().catch(() => {});
  const existe = await P.locator('#indiAssuntos [data-assunto="etapa-clinica"]').count();
  if (!existe) await P.locator('#indiAssuntos [data-assunto^="sim-"]').first().click();
  await P.locator('#indiIr').click();
  const v = await P.evaluate(() => window.__simulacao.indi());
  await P.waitForFunction(() => window.__simulacao.indi()?.naHora === true, null, { timeout: 30000 });
  const bolha = await P.locator('#scenes [data-unit="' + v.unidade + '"] .indi-bubble').innerText();
  await P.locator('#indiVoltar').click();
  await espera(400);
  const depois = await P.evaluate(() => window.__simulacao.indi());
  const oculta = await P.locator('#indiLegenda').isHidden();
  const escondida = await P.locator('#scenes [data-unit="' + v.unidade + '"] .indi-bubble').isHidden();
  return { ok: v.exata === true && /esperando/.test(bolha) && depois === null && oculta && escondida, detalhe: JSON.stringify({ v, bolha: bolha.slice(0, 90) }) };
});
await caso('3D: cena aberta, pontos de atenção em destaque e o resto como contorno', async () => {
  await P.waitForFunction(() => window.__simulacao?.estado3d?.() === 'ready', null, { timeout: 30000 });
  await espera(600);
  const c = await P.evaluate(() => window.__simulacao.cena());
  const a = await P.evaluate(() => window.__simulacao.analise().pontos.length);
  const status = await texto_(P, '#d3Status');
  const canvasPx = await P.evaluate(() => document.querySelector('#scene3d canvas').toDataURL('image/png').length);
  return { ok: c.attention.length >= 1 && c.ghost.length >= 1 && c.people >= 3 && canvasPx > 4000 && /em destaque/.test(status) && a >= 3, detalhe: JSON.stringify({ att: c.attention, ghost: c.ghost, gente: c.people, canvasPx, status }) };
});
await caso('clicar num rótulo do 3D faz a Indi falar sobre aquele ponto', async () => {
  await P.evaluate(() => document.getElementById('sec-3d').scrollIntoView());
  if ((await P.getAttribute('#d3Rotate', 'aria-pressed')) === 'true') await P.click('#d3Rotate'); // a cena parada: o rótulo deixa de se mexer e dá para clicar
  await espera(300);
  const rotulo = P.locator('.label3d:not([data-level=good])').first();
  await rotulo.click({ timeout: 8000 });
  await espera(600);
  const marcados = await P.locator('#indiAssuntos [aria-pressed="true"]').count();
  const fala = await texto(P, '#indiFala dd');
  return { ok: marcados === 1 && fala.length > 10, detalhe: `${marcados} assunto marcado; fala "${fala.slice(0, 80)}"` };
});
await caso('recomendações trazem título, texto e número; indicadores reais aparecem no painel Resumo', async () => {
  const recs = await P.locator('#recommendations li').count();
  const primeira = await texto(P, '#recommendations li');
  const resumo = await texto(P, '#panelBody');
  return { ok: recs >= 1 && /\d/.test(primeira) && /Faltaram/.test(resumo) && /CSI 1/.test(resumo), detalhe: `${recs} recs; "${primeira.replace(/\s+/g, ' ').slice(0, 120)}"` };
});
await caso('uso das estações aparece com porcentagem', async () => {
  const u = await texto(P, '#usage');
  return { ok: /Uso de cada estação/.test(u) && /\d+%/.test(u), detalhe: u.replace(/\s+/g, ' ').slice(0, 100) };
});
await caso('abas de indicadores: faltas (com a situação da confirmação), chegadas, demanda, próximos dias e processo', async () => {
  const checagens = { absence: /Sem resposta[\s\S]*52/, arrival: /Mediana/, demand: /Segunda/, upcoming: /Faltas esperadas/, process: /Antecedência/ };
  const falhas = [];
  for (const [aba, rx] of Object.entries(checagens)) {
    await P.click(`[data-panel="${aba}"]`);
    const t = await texto(P, '#panelBody');
    if (!rx.test(t)) falhas.push(aba);
  }
  await P.click('[data-panel="summary"]');
  return { ok: !falhas.length, detalhe: falhas.join(',') };
});
await caso('o aviso do que o Klingo não informa está na tela', async () => {
  await P.locator('#panelBody summary').click();
  const t = await texto(P, '#panelBody');
  return { ok: /hora de início e de fim do exame/.test(t), detalhe: '' };
});
await caso('testar encaixe: aparece na lista, mostra o efeito e some ao limpar', async () => {
  await P.selectOption('#extraUnit', 'csi1'); await P.selectOption('#extraType', 'us'); await P.selectOption('#extraHour', '9'); await P.fill('#extraQty', '6');
  await P.click('#extraAdd');
  await P.waitForFunction(() => /Efeito dos encaixes/.test(document.getElementById('extraList').textContent), null, { timeout: 15000 });
  const lista = await texto(P, '#extraList');
  await P.click('#extraClear');
  await P.waitForFunction(() => /Nenhum encaixe/.test(document.getElementById('extraList').textContent), null, { timeout: 15000 });
  return { ok: /6 encaixe\(s\) · CSI 1 · Ultrassom/.test(lista), detalhe: lista.replace(/\s+/g, ' ').slice(0, 160) };
});
await caso('premissas: aumentar o guichê muda a simulação e a decisão é recalculada sem erro', async () => {
  const antes = await texto(P, '#metrics');
  await P.locator('#assumptionsCard summary').click();
  await P.fill('#recLow', '25'); await P.fill('#recHigh', '30'); await P.fill('#recHigh', '31');
  await P.fill('[data-duration="us"]', '50'); await P.locator('[data-duration="us"]').dispatchEvent('change');
  await espera(900);
  const depois = await texto(P, '#metrics');
  await P.click('#assumptionsReset'); await espera(300);
  const rec = await P.inputValue('#recLow');
  return { ok: antes !== depois && rec === '3', detalhe: `${antes.replace(/\s+/g, ' ').slice(0, 70)} -> ${depois.replace(/\s+/g, ' ').slice(0, 70)}` };
});
await caso('capacidade: salvar vale para o dia e sobrevive a recarregar a página', async () => {
  await P.click('#sceneUnit'); await P.selectOption('#sceneUnit', 'all');
  const botao = P.locator('#map [data-room="csi2:rm"]');
  await botao.click(); await P.click('#more');
  await P.click('#capacitySave'); await espera(500);
  const status = await texto(P, '#capacityStatus');
  await P.reload();
  await P.waitForFunction(() => document.getElementById('sourceStatus').textContent.includes('#14359'), null, { timeout: 15000 });
  await P.waitForSelector('#map [data-room="csi2:rm"]');
  const t = await P.locator('#map [data-room="csi2:rm"]').innerText();
  const guardada = await texto(P, '#capacityStatus');
  return { ok: /Capacidade salva/.test(status) && /Capacidade salva/.test(guardada) && /\d estação/.test(t), detalhe: t.replace(/\s+/g, ' ') };
});
await caso('o que falta nos dados: só porcentagens por situação, resumo na seção 1 e nenhum dado pessoal', async () => {
  await P.waitForFunction(() => document.getElementById('gapsLine').textContent.includes('Dados que faltam'), null, { timeout: 15000 });
  const linha = await texto_(P, '#gapsLine');
  await P.click('[data-panel="gaps"]');
  const t = await texto_(P, '#panelBody');
  const celulas = await P.locator('#panelBody table.gaps tbody td').count();
  return { ok: /Dados que faltam/.test(linha) && /Início e fim do exame/.test(t) && /Só contagem/.test(t) && celulas >= 20 && /têm/.test(t) && /ainda não há leitura da hora real/.test(t), detalhe: linha.replace(/\s+/g, ' ').slice(0, 140) };
});
await caso('trocar de dia: ontem é "dia fechado" e amanhã é "dia futuro", ambos carregam', async () => {
  await P.click('#dayBack');
  await P.waitForFunction(() => document.getElementById('sourceStatus').textContent.includes('Dia fechado'), null, { timeout: 15000 });
  await P.click('#dayToday'); await P.click('#dayNext');
  await P.waitForFunction(() => document.getElementById('sourceStatus').textContent.includes('Dia futuro'), null, { timeout: 15000 });
  const rows = await P.locator('#rows tr').count();
  return { ok: rows > 50, detalhe: `${rows} linhas na jornada individual` };
});
await caso('hora real registrada: a opção aparece quando há início e fim e o modo mostra espera medida sem erro', async () => {
  await P.click('#dayToday'); await espera(800); await P.click('#dayBack');
  await P.waitForFunction(() => document.getElementById('sourceStatus').textContent.includes('Dia fechado'), null, { timeout: 15000 });
  await P.waitForFunction(() => [...document.getElementById('dataMode').options].some((o) => o.value === 'observed'), null, { timeout: 15000 });
  await P.selectOption('#dataMode', 'observed');
  await P.waitForFunction(() => document.getElementById('metrics').textContent.includes('concluídos'), null, { timeout: 15000 });
  const m = await texto_(P, '#metrics');
  await P.selectOption('#dataMode', 'forecast');
  await P.waitForFunction(() => document.getElementById('metrics').textContent.includes('espera P90'), null, { timeout: 15000 });
  return { ok: /marcações com eventos/.test(m), detalhe: m.replace(/\s+/g, ' ').slice(0, 130) };
});
await caso('sem erro de JavaScript durante todo o uso', async () => ({ ok: logada.erros.length === 0, detalhe: logada.erros.join(' | ') }));
await logada.ctx.close();

await caso('sem WebGL: a página avisa, mantém os assuntos da Indi e não dá erro', async () => {
  const semGl = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH, args: ['--no-sandbox', '--disable-3d-apis', '--disable-gpu', '--disable-webgl', '--disable-webgl2'] } : {});
  const { p, ctx, erros } = await pagina(semGl, { logado: true });
  await p.goto(URL_BASE);
  await p.waitForFunction(() => ['off', 'ready'].includes(window.__simulacao?.estado3d?.()), null, { timeout: 30000 });
  const estado = await p.evaluate(() => window.__simulacao.estado3d());
  const msg = estado === 'off' ? await p.locator('#scene3dMsg').innerText() : '';
  const itens = await p.locator('#indiAssuntos [data-assunto]').count();
  await ctx.close(); await semGl.close();
  return { ok: estado === 'off' && /WebGL/.test(msg) && itens >= 3 && !erros.length, detalhe: `estado ${estado}; ${itens} pontos; erros ${erros.join('|')}` };
});
await caso('celular (390 px): sem rolagem lateral e decisão visível', async () => {
  const { p, ctx } = await pagina(browser, { logado: true }, { width: 390, height: 800 });
  await p.goto(URL_BASE);
  await p.waitForSelector('#recommendations li', { timeout: 15000 });
  const largura = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  await ctx.close();
  return { ok: largura.sw <= largura.iw + 1, detalhe: JSON.stringify(largura) };
});

await browser.close(); srv.close();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
