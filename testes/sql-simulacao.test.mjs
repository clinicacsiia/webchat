// FLUXOGRAMA: entrada (o retrato da produção montado num Postgres embutido + supabase/simulacao-dados.sql) -> validação (dados INVENTADOS: marcações, chegadas, faltas e cancelamentos de dois dias; confere modalidade, unidade, formato do JSON, privacidade e permissão) -> saída (PASS/FAIL por verificação; código de saída 1 se algo falhar)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (funções de leitura da simulação)
// Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/simulacao-dados.sql`, 'utf8'));

const ADMIN = '00000000-0000-4000-8000-0000000000a1', PACIENTE = '00000000-0000-4000-8000-0000000000b1';
await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}', 'admin@exemplo.invalid'), ('${PACIENTE}', 'paciente@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADMIN}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true);
  insert into public.jornada_coluna (id, nome, ordem, etapa, origem, sla_min) values
    ('a_confirmar', 'A confirmar', 10, 'agendamento', 'klingo', null), ('confirmado', 'Confirmado', 11, 'agendamento', 'klingo', null),
    ('em_atendimento', 'Em atendimento', 12, 'depois', 'klingo', null), ('finalizado', 'Finalizado', 20, 'depois', 'klingo', null)
    on conflict (id) do nothing;
`);

await caso('o retrato monta sem falha e as 4 funções novas existem', async () => {
  const n = await um(`select count(*)::int as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and p.proname in ('sim_unidade', 'sim_modalidade', 'painel_simulacao_dia', 'painel_simulacao_indicadores')`);
  return { ok: falhas.length === 0 && n.n === 4, detalhe: `${n.n} funções, ${falhas.length} falhas` };
});

await caso('sim_modalidade reconhece os nomes reais do Klingo', async () => {
  const casos = {
    'CONSULTA': 'consulta', 'CONSULTA NEUROPEDIATRIA': 'consulta', 'ATENDIMENTO AMBULATORIAL EM PUERICULTURA': 'consulta', 'ELETROENCEFALOGRAMA EM SONO E VIGILIA': 'consulta',
    'USG TRANSVAGINAL PARA DIAGNOSTICO DE ENDOMETRIOSE': 'us', 'US ABDOME TOTAL (INCLUI PELVE)': 'us', 'DOPPLER CAROTIDAS E VERTEBRAIS': 'us', 'ELASTOGRAFIA HEPÁTICA ULTRASSÔNICA': 'us',
    'RM PELVE (NÃO INCLUI ARTICULAÇÕES)': 'rm', 'PCTE RM E/OU ANGIORM ESTRUTURAS PELVICAS': 'rm', 'HIDRO-RM (COLÂNGIO-RM OU URO-RM)': 'rm', 'TC DE CRANIO': 'tc', 'TOMOGRAFIA COMPUTADORIZADA': 'tc',
    'DENSITOMETRIA ÓSSEA - 2 SEGMENTOS': 'dmo', 'MAMOGRAFIA BILATERAL': 'mamo', 'RX TÓRAX PA/PERFIL': 'rx', 'HISTEROSSALPINGOGRAFIA': 'rx', 'ENEMA OPACO': 'rx',
    'ECODOPPLERCARDIOGRAMA TRANSTORÁCICO': 'eco', 'ECG CONVENCIONAL DE ATÉ 12 DERIVAÇÕES': 'eco', 'HISTEROSCOPIA DIAGNÓSTICA': 'histero', 'CIRURGIA X': null,
  };
  const erros = [];
  for (const [nome, esperado] of Object.entries(casos)) {
    const r = await um(`select public.sim_modalidade($1) as m`, [nome]);
    if (r.m !== esperado) erros.push(`${nome} -> ${r.m} (esperado ${esperado})`);
  }
  return { ok: !erros.length, detalhe: erros.join('; ') || `${Object.keys(casos).length} nomes` };
});

await caso('sim_unidade traduz as 3 unidades e ignora o resto', async () => {
  const r = await um(`select public.sim_unidade('CSI 1') a, public.sim_unidade('CSI 2') b, public.sim_unidade('CSI Pediatria') c, public.sim_unidade('') d, public.sim_unidade(null) e`);
  return { ok: r.a === 'csi1' && r.b === 'csi2' && r.c === 'ped' && r.d === null && r.e === null, detalhe: JSON.stringify(r) };
});

// ---------------------------------------------------------------- dados inventados
// Dia passado fechado: ontem. Dia futuro: daqui a 3 dias.
const hoje = (await um(`select (now() at time zone 'America/Sao_Paulo')::date as d`)).d.toISOString().slice(0, 10);
const dia = (delta) => { const d = new Date(hoje + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + delta); return d.toISOString().slice(0, 10); };
const ONTEM = dia(-1), FUTURO = dia(3);
let mid = 1000;
const card = async (chave, data, unidade, coluna = 'a_confirmar') => (await um(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna) values ($1, $2, $3, $4) returning id`, [chave, data, unidade, coluna])).id;
const exame = async (cardId, { proc = 'US ABDOME TOTAL', unidade = 'CSI 1', data, hora = '09:00', status = 'agendado', confirm = 'Confirmado', m = null }) =>
  (await um(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, unidade, agendado_em, agendado_para, status, confirm_status)
             values ($1, $2, $3, $4, ($5::date - 5)::timestamp at time zone 'America/Sao_Paulo', ($5 || ' ' || $6)::timestamp at time zone 'America/Sao_Paulo', $7, $8) returning id`,
    [cardId, m ?? `m${++mid}`, proc, unidade, data, hora, status, confirm])).id;
const chegou = async (cardId, data, hora) => db.query(`insert into public.jornada_evento (card_id, tipo, origem, para_coluna, quando) values ($1, 'movido', 'klingo', 'em_atendimento', ($2 || ' ' || $3)::timestamp at time zone 'America/Sao_Paulo')`, [cardId, data, hora]);

// Pessoa A: ultrassom 09:00 + consulta 10:00 na mesma unidade, chegou 08:50 (um card, dois exames)
const cA = await card('SEGREDO-A', ONTEM, 'CSI 1');
const eA1 = await exame(cA, { data: ONTEM, hora: '09:00', status: 'atendido' });
await exame(cA, { proc: 'CONSULTA', data: ONTEM, hora: '10:00', status: 'atendido' });
await chegou(cA, ONTEM, '08:50');
// Pessoa B: ressonância CSI 2, faltou (sem chegada)
const cB = await card('SEGREDO-B', ONTEM, 'CSI 2');
await exame(cB, { proc: 'RM CRANIO', unidade: 'CSI 2', data: ONTEM, hora: '08:00', status: 'faltou', confirm: 'Sem Resposta' });
// Pessoa C: cancelada, remarcada e fora do modelo
const cC = await card('SEGREDO-C', ONTEM, 'CSI 1');
await exame(cC, { data: ONTEM, hora: '11:00', status: 'cancelado' });
await exame(cC, { data: ONTEM, hora: '11:30', status: 'remarcado' });
await exame(cC, { proc: 'CIRURGIA X', data: ONTEM, hora: '12:00', status: 'atendido' });
// Atendido com a chegada registrada em OUTRO dia (primeira leitura do sync): não vira chegada
const cD = await card('SEGREDO-D', ONTEM, 'CSI Pediatria');
await exame(cD, { proc: 'CONSULTA NEUROPEDIATRIA', unidade: 'CSI Pediatria', data: ONTEM, hora: '14:00', status: 'atendido', confirm: 'A Confirmar' });
await chegou(cD, dia(-3), '10:00');
// Pedido do chat sem marcação (marcacao 'i..'): fora
const cE = await card('SEGREDO-E', ONTEM, 'CSI 1');
await exame(cE, { data: ONTEM, hora: '15:00', status: 'pedido', m: 'i9001' });
// Futuro
const cF = await card('SEGREDO-F', FUTURO, 'CSI 1');
await exame(cF, { data: FUTURO, hora: '08:30', status: 'agendado', confirm: 'Sem Resposta' });
const cG = await card('SEGREDO-G', FUTURO, 'CSI 2');
await exame(cG, { proc: 'TC CRANIO', unidade: 'CSI 2', data: FUTURO, hora: '09:00', status: 'confirmado', confirm: 'Confirmado' });
// 25 atendimentos com chegada para a calibragem de pontualidade (CSI 1)
for (let i = 0; i < 25; i++) {
  const c = await card('SEGREDO-X' + i, ONTEM, 'CSI 1');
  await exame(c, { data: ONTEM, hora: '13:00', status: 'atendido' });
  await chegou(c, ONTEM, i % 2 ? '12:50' : '13:10');
}

await caso('sem login, o paciente e o anônimo NÃO chamam as funções (permissão)', async () => {
  await anonimo();
  let bloqueadoAnon = false;
  try { await q(`select public.painel_simulacao_dia(current_date)`); } catch { bloqueadoAnon = true; }
  await como(PACIENTE);
  let bloqueadoPaciente = false;
  try { await q(`select public.painel_simulacao_indicadores(28)`); } catch { bloqueadoPaciente = true; }
  await como(null);
  return { ok: bloqueadoAnon && bloqueadoPaciente, detalhe: `anon ${bloqueadoAnon}, paciente ${bloqueadoPaciente}` };
});

await como(ADMIN);
const passado = (await um(`select public.painel_simulacao_dia($1::date) as j`, [ONTEM])).j;
const futuro = (await um(`select public.painel_simulacao_dia($1::date) as j`, [FUTURO])).j;

await caso('dia passado: formato da simulação, só marcações do Klingo, sem cancelada/remarcada/fora do modelo/pedido', async () => {
  const v = passado.visits;
  const tipos = v.map((x) => x.type + '@' + x.slot).sort().join(',');
  return { ok: passado.date === ONTEM && /Z$/.test(passado.asOf) && v.length === 29 && passado.meta.canceladas_ou_remarcadas === 2 && passado.meta.fora_do_modelo === 1 && passado.meta.marcacoes_no_dia === 32 && tipos.includes('rm@480') && tipos.includes('consulta@840'),
    detalhe: `visits ${v.length}, meta ${JSON.stringify(passado.meta)}` };
});

await caso('chegada real vira "arrive" em minutos do dia, só se foi no mesmo dia; falta vira absentAt; atendido sem chegada fica sem arrive', async () => {
  const v = passado.visits;
  const us = v.find((x) => x.id === eA1);
  const rm = v.find((x) => x.type === 'rm');
  const ped = v.find((x) => x.unit === 'ped');
  return { ok: us.arrive === 8 * 60 + 50 && rm.arrive === undefined && rm.absentAt === 8 * 60 + 15 && ped.arrive === undefined && ped.absentAt === undefined && us.done === true && rm.confirm === 'sem_resposta' && ped.confirm === 'a_confirmar',
    detalhe: JSON.stringify({ us, rm, ped }) };
});

await caso('a mesma pessoa tem o mesmo número nos dois exames e nada identifica o paciente', async () => {
  const a = passado.visits.filter((x) => x.type === 'us' && x.slot === 540 || x.type === 'consulta' && x.slot === 600);
  const texto = JSON.stringify(passado) + JSON.stringify(futuro);
  return { ok: a.length === 2 && a[0].person === a[1].person && !/SEGREDO|Maria|cpf|nome|telefone|prontuario/i.test(texto), detalhe: 'pessoas ' + a.map((x) => x.person).join('/') };
});

await caso('dia futuro: asOf é agora, ninguém chegou, nada de faltas e a confirmação vem junto', async () => {
  const v = futuro.visits;
  return { ok: futuro.date === FUTURO && v.length === 2 && v.every((x) => x.arrive === undefined && x.absentAt === undefined) && v.find((x) => x.type === 'tc').confirm === 'confirmado', detalhe: JSON.stringify(v) };
});

await caso('histórico: só dias fechados anteriores ao dia pedido, com booked (atendido+faltou) e arrivals', async () => {
  const h = futuro.history;
  const us9 = h.find((x) => x.date === ONTEM && x.hour === 9 && x.unit === 'csi1' && x.type === 'us');
  const rm8 = h.find((x) => x.date === ONTEM && x.hour === 8 && x.unit === 'csi2' && x.type === 'rm');
  const naoFecha = h.every((x) => x.date < hoje);
  const dentroDoPassado = passado.history.every((x) => x.date < ONTEM);
  return { ok: us9?.booked === 1 && us9?.arrivals === 1 && rm8?.booked === 1 && rm8?.arrivals === 0 && naoFecha && dentroDoPassado, detalhe: JSON.stringify({ us9, rm8 }) };
});

await caso('calibragem: taxa de falta por confirmação e quantis da chegada (só com 20+ casos)', async () => {
  const c = futuro.calibragem;
  const q = c.chegada.csi1;
  return { ok: c.faltaPorConfirmacao.sem_resposta.taxa === 100 && c.faltaPorConfirmacao.confirmado.taxa === 0 && q && q.n >= 25 && q.quantis.length === 11 && q.quantis[0] <= q.quantis[10] && !c.chegada.csi2,
    detalhe: JSON.stringify({ fc: c.faltaPorConfirmacao, n: q?.n, q: q?.quantis?.map((x) => Math.round(x)) }) };
});

await caso('indicadores: estrutura completa e números certos', async () => {
  const j = (await um(`select public.painel_simulacao_indicadores(28) as j`)).j;
  const chaves = ['periodo', 'unidades', 'modalidades', 'confirmacao', 'semana', 'horas', 'pontualidade', 'antecedencia', 'proximos', 'origem', 'pedidos_chat', 'fila_chegada'];
  const faltam = chaves.filter((k) => !(k in j));
  const csi1 = j.unidades.find((u) => u.unidade === 'csi1');
  const csi2 = j.unidades.find((u) => u.unidade === 'csi2');
  const prox = j.proximos.find((p) => p.dia === FUTURO && p.unidade === 'csi1');
  const pont = j.pontualidade.find((p) => p.unidade === 'csi1');
  return { ok: !faltam.length && csi2.faltaram === 1 && csi2.pct_falta === 100 && csi1.canceladas === 1 && csi1.remarcadas === 1 && prox.marcadas === 1 && prox.sem_resposta === 1 && prox.faltas_esperadas === 1 && pont.n >= 25 && pont.p10 < pont.p90,
    detalhe: faltam.join(',') || JSON.stringify({ csi1, prox, pont }) };
});

await caso('janela: recusa data a mais de 120 dias; dias de indicadores limitados a 90', async () => {
  let recusou = false;
  try { await q(`select public.painel_simulacao_dia(current_date + 400)`); } catch { recusou = true; }
  const j = (await um(`select public.painel_simulacao_indicadores(9999) as j`)).j;
  return { ok: recusou && j.periodo.dias === 90, detalhe: `recusou ${recusou}, dias ${j.periodo.dias}` };
});

await caso('só leitura: as funções não alteram nenhuma linha', async () => {
  await como(null);
  const n = await um(`select (select count(*) from public.jornada_exame)::int a, (select count(*) from public.jornada_evento)::int b`);
  await como(ADMIN);
  await q(`select public.painel_simulacao_dia(current_date)`);
  await q(`select public.painel_simulacao_indicadores(28)`);
  await como(null);
  const m = await um(`select (select count(*) from public.jornada_exame)::int a, (select count(*) from public.jornada_evento)::int b`);
  return { ok: n.a === m.a && n.b === m.b, detalhe: JSON.stringify({ n, m }) };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
