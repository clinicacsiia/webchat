// FLUXOGRAMA: entrada (simulacao/engine.mjs, integration.mjs e decisao.mjs + o exemplo examples/snapshot.json + dados inventados aqui) -> validação (motor, normalização do retorno do banco, calibragem pela clínica, recomendações e painéis) -> saída (PASS/FAIL por verificação; código de saída 1 se algo falhar)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (inclui os testes do pacote portátil v2.0, adaptados)
// Nenhum dado de paciente: tudo inventado.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as E from '../simulacao/engine.mjs';
import * as D from '../simulacao/decisao.mjs';
import { normalizeSnapshot, prepareSnapshot } from '../simulacao/integration.mjs';

const example = JSON.parse(await readFile(new URL('../simulacao/examples/snapshot.json', import.meta.url), 'utf8'));
const Q = [-40, -30, -20, -14, -10, -6, -3, 0, 6, 15, 25]; // quantis de chegada inventados (min em relação ao horário)

// Dia inventado no formato que o banco devolve (painel_simulacao_dia)
function dia({ date = '2026-11-12', asOf = '2026-11-13T09:00:00Z', n = 24, extra = {} } = {}) {
  const visits = [];
  for (let i = 0; i < n; i++) {
    const hour = 8 + Math.floor(i / 3);
    visits.push({
      id: i + 1, person: i + 1, unit: 'csi1', type: 'us', slot: hour * 60 + (i % 3) * 20,
      confirm: ['confirmado', 'a_confirmar', 'sem_resposta'][i % 3], ...(i % 5 === 0 ? { absentAt: hour * 60 + (i % 3) * 20 + 15 } : { arrive: hour * 60 + (i % 3) * 20 - 5, done: true }),
    });
  }
  return {
    date, asOf, visits, capacity: {}, outage: null, ...extra,
    history: [{ date: '2026-11-05', hour: 9, unit: 'csi1', type: 'us', booked: 6, arrivals: 5 }],
    calibragem: {
      faltaPorConfirmacao: { confirmado: { taxa: 11, n: 100 }, a_confirmar: { taxa: 35, n: 40 }, sem_resposta: { taxa: 54, n: 50 } }, faltaGeral: 17,
      chegada: { csi1: { n: 200, quantis: Q } },
    },
    meta: { marcacoes_no_dia: n + 3, canceladas_ou_remarcadas: 3, fora_do_modelo: 0, com_chegada_real: 19, faltas_registradas: 5, sync_klingo_em: '2026-11-13T08:59:30Z' },
  };
}

// ---------------- testes do pacote portátil (v2.0), mantidos ----------------
test('O snapshot registra somente as etapas recebidas e exclui identificadores extras', () => {
  const input = structuredClone(example);
  input.visits[0].nome = 'CAMPO EXTERNO';
  const { observed, cut } = prepareSnapshot(normalizeSnapshot(input, example.date));
  assert.equal(cut, 615);
  const patient = observed.jobs[0];
  assert(!Object.hasOwn(patient, 'nome'));
  assert.equal(E.stage(patient, 615), 'examQueue');
  assert.equal(E.patientStatus(patient, 615).mood, 'angry');
  assert.equal(E.stage(observed.jobs[1], 615), 'finished');
  assert.equal(E.stage(observed.jobs[4], 615), 'future');
  assert.equal(E.stage(observed.jobs[3], 589), 'future');
  assert.equal(E.stage(observed.jobs[3], 590), 'absent');
  assert.equal(E.occupancyTimeline(observed.jobs, 'all', cut).counts.at(-1), 2);
});

test('A previsão combina histórico e agenda sem duplicar volume por faixa', () => {
  const { roster, historicalDays, historicalVisits, plan } = prepareSnapshot(normalizeSnapshot(example));
  assert.equal(historicalDays, 3);
  assert.equal(historicalVisits, 20);
  const ultrasound = roster.filter((r) => r.slot >= 660 && r.slot < 720 && r.unit === 'csi1' && r.type === 'us');
  assert.equal(ultrasound.length, 7);
  assert.equal(ultrasound.filter((r) => !r.historical).length, 1);
  assert.equal(roster.filter((r) => r.slot < 615 && r.historical).length, 0);
  const result = E.simulate(roster, plan, E.seeds[0], false, 0);
  assert.equal(result.jobs.find((job) => job.id === 102).examTime, 28);
  assert.equal(result.jobs.find((job) => job.id === 101).absent, false);
  assert(result.jobs.find((job) => job.id === 104).absent);
  assert.equal(result.downtime, null);
});

test('Dora abre a explicação do atraso e de uma estação com parada em andamento', () => {
  const { observed, cut, plan } = prepareSnapshot(normalizeSnapshot(example));
  const incidents = E.patrolIncidents(observed);
  const wait = incidents.find((r) => r.job.id === 101 && r.kind === 'wait');
  assert.equal(E.patrols[wait.unit].name, 'Dora');
  const explanation = E.patrolExplanation(wait, cut, observed, plan);
  assert.match(explanation.location, /Área de espera/);
  assert.match(explanation.reason, /Maior espera em fila: 105 min/);
  const outage = incidents.find((r) => r.kind === 'downtime');
  assert.equal(outage.to, null);
  assert.match(E.patrolExplanation(outage, cut, observed, plan).reason, /liberação ainda não foi registrada/);
});

test('Rejeita data diferente, eventos posteriores ao snapshot e histórico repetido', () => {
  assert.throws(() => normalizeSnapshot(example, '2026-11-17'), /diferente/);
  const invalid = structuredClone(example);
  invalid.visits[0].start = 630;
  assert.throws(() => normalizeSnapshot(invalid), /posterior/);
  invalid.visits[0].start = null;
  invalid.history.push(invalid.history[0]);
  assert.throws(() => normalizeSnapshot(invalid), /duas vezes/);
});

// ---------------- novidades da versão ligada ao banco ----------------
test('normalizeSnapshot aceita o formato do banco e guarda confirmação, atendido, calibragem e meta', () => {
  const s = normalizeSnapshot(dia(), '2026-11-12');
  assert.equal(s.visits.length, 24);
  assert.equal(s.visits[1].confirm, 'a_confirmar');
  assert.equal(s.visits[1].done, true);
  assert.equal(s.visits[0].absentAt, 8 * 60 + 15);
  assert.equal(s.calibration.absenceByConfirm.sem_resposta.rate, 54);
  assert.deepEqual(s.calibration.arrival.csi1.quantiles, Q);
  assert.equal(s.meta.com_chegada_real, 19);
  assert.equal(s.meta.sync, '2026-11-13T08:59:30.000Z');
  // quantis fora de ordem ou do tamanho errado são descartados (o motor cai no padrão)
  const ruim = dia(); ruim.calibragem.chegada.csi1.quantis = [3, 2, 1];
  assert.deepEqual(normalizeSnapshot(ruim).calibration.arrival, {});
  // confirmação desconhecida vira nula; campos extras (como nome) não passam
  const extra = dia(); extra.visits[2].confirm = 'talvez'; extra.visits[2].nome = 'NÃO PODE';
  const n = normalizeSnapshot(extra);
  assert.equal(n.visits[2].confirm, null);
  assert(!JSON.stringify(n).includes('NÃO PODE'));
});

test('sampleQuantile percorre os quantis em ordem e limita as pontas', () => {
  assert.equal(E.sampleQuantile(Q, 0.5), -6);
  assert.equal(E.sampleQuantile(Q, 0.05), -40);
  assert(E.sampleQuantile(Q, 0.01) < -40 && E.sampleQuantile(Q, 0.01) >= -70);
  assert(E.sampleQuantile(Q, 0.99) > 25 && E.sampleQuantile(Q, 0.99) <= 55);
  let anterior = -Infinity;
  for (let u = 0.02; u < 0.99; u += 0.02) { const v = E.sampleQuantile(Q, u); assert(v >= anterior); anterior = v; }
});

test('quem já foi atendido nunca vira falta; a falta usa a taxa da situação da confirmação', () => {
  const p = prepareSnapshot(normalizeSnapshot(dia()));
  assert(p.roster.filter((r) => r.knownPresent).every((r) => r.knownPresent === true));
  const rates = new Map(p.roster.filter((r) => !r.historical).map((r) => [r.confirm, r.absenceRate]));
  assert.equal(rates.get('sem_resposta'), 54);
  assert.equal(rates.get('a_confirmar'), 35);
  assert.equal(rates.get('confirmado'), 11);
  // roda 40 sorteios: nenhum atendido vira falta, mesmo com taxa 100%
  const forcado = structuredClone(p.roster).map((r) => ({ ...r, absenceRate: 100 }));
  for (let seed = 1; seed <= 40; seed++) {
    const out = E.simulate(forcado, p.plan, seed, false, 0);
    for (const job of out.jobs) if (job.knownPresent) assert.equal(job.absent, false);
  }
});

test('chegada real é respeitada (limitada ao início do dia) e a sorteada segue os quantis medidos', () => {
  const p = prepareSnapshot(normalizeSnapshot(dia()));
  const out = E.simulate(p.roster, p.plan, E.seeds[0], false, 0);
  for (const row of p.roster.filter((r) => Number.isFinite(r.actualArrival))) assert.equal(out.jobs.find((j) => j.id === row.id).arrive >= E.OPEN, true);
  // sem chegada real: 400 sorteios caem em volta da mediana dos quantis (-6) e não na distribuição padrão (-6 ± 22 também): compara dispersão
  const base = { id: 1, person: 1, unit: 'csi1', type: 'us', slot: 720, previous: null, transfer: 0, absenceRate: 0 };
  const largas = [], estreitas = [];
  for (let seed = 1; seed <= 400; seed++) {
    largas.push(E.simulate([{ ...base, arrivalQ: [-80, -60, -40, -20, -10, 0, 10, 20, 40, 60, 80] }], { 'csi1:reception': 1, 'csi1:prep': 1, 'csi1:us': 1 }, seed, false, 0).jobs[0].arrive - 720);
    estreitas.push(E.simulate([{ ...base, arrivalQ: [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4] }], { 'csi1:reception': 1, 'csi1:prep': 1, 'csi1:us': 1 }, seed, false, 0).jobs[0].arrive - 720);
  }
  const dp = (a) => { const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
  assert(dp(largas) > 3 * dp(estreitas), `dp largas ${dp(largas)} vs estreitas ${dp(estreitas)}`);
});

test('quem passou 45 min do horário sem chegar vira falta provável; quem está na tolerância só chega daqui para frente', () => {
  const d = dia({ asOf: '2026-11-12T13:00:00Z', n: 0 }); // 10:00 em Salvador
  d.visits = [
    { id: 1, person: 1, unit: 'csi1', type: 'us', slot: 8 * 60 },        // 8h, não chegou: provável falta
    { id: 2, person: 2, unit: 'csi1', type: 'us', slot: 9 * 60 + 40 },   // 9h40, ainda na tolerância
    { id: 3, person: 3, unit: 'csi1', type: 'us', slot: 11 * 60 },       // futuro
    { id: 4, person: 4, unit: 'csi1', type: 'us', slot: 8 * 60 + 30, done: true }, // atendido sem chegada registrada
  ];
  const p = prepareSnapshot(normalizeSnapshot(d, '2026-11-12'));
  assert.equal(p.cut, 600);
  const byId = (id) => p.roster.find((r) => r.id === id);
  assert.equal(byId(1).knownAbsent, true); assert.equal(byId(1).probableAbsence, true);
  assert.equal(byId(2).notBefore, 600);
  assert.equal(byId(3).notBefore, undefined);
  assert.equal(byId(4).actualArrival, 8 * 60 + 30);
  assert.equal(p.probableAbsences, 1);
  const out = E.simulate(p.roster, p.plan, E.seeds[0], false, 0);
  assert(out.jobs.find((j) => j.id === 2).arrive >= 600);
});

test('premissas editáveis mudam o resultado e valores inválidos voltam ao padrão', () => {
  const p = prepareSnapshot(normalizeSnapshot(dia()));
  const antes = E.simulate(p.roster, p.plan, E.seeds[0], false, 0).summary.p90;
  E.setAssumptions({ reception: [20, 25], prep: [4, 8], duration: { us: 60 } });
  const depois = E.simulate(p.roster, p.plan, E.seeds[0], false, 0).summary.p90;
  assert(depois > antes, `${depois} deveria ser maior que ${antes}`);
  assert.equal(E.refMinutes('us'), 60);
  E.setAssumptions({ reception: [9, 2], prep: 'x', duration: { us: 1, rm: 500, banana: 30 } }); // tudo inválido
  assert.deepEqual(E.assumptions.reception, [3, 6]);
  assert.deepEqual(E.assumptions.prep, [4, 8]);
  assert.deepEqual(E.assumptions.duration, {});
  E.setAssumptions({});
});

test('utilização das estações fica entre 0 e 150% e some 0 onde não há trabalho', () => {
  const p = prepareSnapshot(normalizeSnapshot(dia()));
  const { summary } = E.simulate(p.roster, p.plan, E.seeds[0], false, 0);
  const use = E.utilization(summary, p.plan);
  assert(use['csi1:us'] > 0 && use['csi1:us'] <= 1.5);
  assert.equal(use['csi2:rm'] ?? 0, 0);
});

test('stationTests sugere estação a mais onde há fila e nunca altera o plano recebido', () => {
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push({ id: i + 1, person: i + 1, unit: 'csi2', type: 'rm', slot: 8 * 60 + (i % 3) * 10 + Math.floor(i / 3) * 12, previous: null, transfer: 0, absenceRate: 0, knownPresent: true });
  const plan = { 'csi1:reception': 1, 'csi1:prep': 1, 'csi2:reception': 1, 'csi2:prep': 1, 'csi2:rm': 1, 'ped:reception': 1, 'ped:prep': 1 };
  const copia = structuredClone(plan);
  const r = D.stationTests(rows, plan, 0, false);
  assert.deepEqual(plan, copia);
  const rm = r.more.find((x) => x.pool === 'csi2:rm');
  assert(rm, 'esperava teste de estação a mais em csi2:rm');
  assert(rm.after.p90 < rm.before.p90, `${rm.after.p90} < ${rm.before.p90}`);
  const recs = D.buildRecommendations({ summary: E.simulate(rows, plan, E.seeds[0], false, 0).summary, tests: r, absence: { rows: [] }, confirmation: { total: 0, lines: [] }, indicators: null, mode: 'forecast' });
  assert(recs.some((x) => /Mais uma estação em CSI 2 · Ressonância/.test(x.title)));
  assert.equal(recs[0].level, 'alta');
});

test('absencePlan e confirmationOpportunity usam só quem ainda não resolveu', () => {
  const manha = dia({ asOf: '2026-11-12T11:30:00Z' }); // 08:30 em Salvador: ninguém pode ter chegada nem falta depois disso
  for (const v of manha.visits) { if (v.arrive > 510) { delete v.arrive; delete v.done; } if (v.absentAt > 510) delete v.absentAt; }
  const p = prepareSnapshot(normalizeSnapshot(manha, '2026-11-12'));
  const plan = D.absencePlan(p.roster, 17);
  assert(plan.openCount > 0 && plan.openCount < p.roster.length);
  assert(plan.rows.every((r) => r.suggested === Math.floor(r.expected * 0.6)));
  const opp = D.confirmationOpportunity(p.roster, p.calibration);
  const sr = opp.lines.find((l) => l.state === 'sem_resposta');
  assert.equal(sr.rate, 54);
  assert.equal(opp.confirmedRate, 11);
  assert.equal(sr.gain, Math.round(sr.n * (54 - 11) / 100 * 0.5 * 10) / 10);
});

test('painéis escapam texto e funcionam com os números do banco', () => {
  const ind = {
    periodo: { de: '2026-10-18', ate: '2026-11-14', dias: 28, dias_com_dado: 15, primeiro_dia_do_banco: '2026-10-30' },
    unidades: [{ unidade: 'csi1', marcadas: 100, atendidas: 80, faltaram: 12, canceladas: 5, remarcadas: 3, pct_falta: 13, pct_cancela_remarca: 8 }],
    modalidades: [{ unidade: 'csi1', tipo: 'us', n: 50, dias: 10, por_dia: 5, pct_falta: 12 }],
    confirmacao: [{ situacao: 'Confirmado', n: 90, faltaram: 10, pct_falta: 11.1 }, { situacao: 'Sem Resposta', n: 20, faltaram: 11, pct_falta: 55 }, { situacao: 'x', n: 3, faltaram: 0, pct_falta: 0 }],
    semana: [{ dow: 1, unidade: 'csi1', media_por_dia: 20, dias: 2, pct_falta: 10 }],
    horas: [{ hora: 9, unidade: 'csi1', media_por_dia: 4, pct_falta: 20, dias: 10 }],
    pontualidade: [{ unidade: 'csi1', n: 50, p10: -40, p50: -6, p90: 25, pct_15_antes: 30, pct_15_depois: 10 }],
    antecedencia: { n: 100, p50_dias: 7, p90_dias: 30, pct_menos_de_1_dia: 16 },
    proximos: [{ dia: '2026-11-16', unidade: 'csi1', marcadas: 50, confirmadas: 30, a_confirmar: 10, sem_resposta: 10, faltas_esperadas: 9.5 }],
    origem: [{ origem: '<img src=x onerror=alert(1)>', n: 3, do_chat: 1 }], pedidos_chat: [{ situacao: 'novo', n: 4 }], fila_chegada: { n: 5, atendidos: 5, espera_mediana_min: 0.8 },
  };
  for (const f of [D.panelSummary, D.panelAbsence, D.panelArrival, D.panelDemand, D.panelUpcoming, D.panelProcess]) {
    const html = f(ind);
    assert(html.length > 40);
    assert(!/<img src=x/.test(html), 'texto vindo do banco precisa ser escapado');
  }
  assert.match(D.panelAbsence(ind), /Sem resposta/);
  assert.match(D.panelProcess(ind), /Amostra pequena demais/);
  assert.equal(D.panelSummary(null), '');
  const recs = D.buildRecommendations({ summary: { total: 10, missed: 0, over: 0, last: 900 }, tests: { more: [], less: [] }, absence: { rows: [] }, confirmation: { total: 0, lines: [] }, indicators: ind, mode: 'forecast', meta: { com_chegada_real: 3 } });
  assert(recs.some((r) => /Chegam cedo em CSI 1/.test(r.title)));
  assert(recs.some((r) => /quase não é medida/.test(r.title)));
});
