// FLUXOGRAMA: entrada (o retrato da produção em Postgres embutido + simulacao-hora-real.sql e simulacao-dados.sql) -> validação (dados INVENTADOS: marcações com e sem hora real, chegada aproximada pelo Klingo, cancelamento sem motivo; confere a gravação, as recusas, a prioridade da hora real, as durações no histórico e o mapa do que falta) -> saída (PASS/FAIL por verificação; código de saída 1 se algo falhar)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (hora real e lacunas da simulação)
// Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
for (const f of ['simulacao-hora-real.sql', 'simulacao-dados.sql']) await db.exec(readFileSync(`${REPO}/supabase/${f}`, 'utf8'));

const ADMIN = '00000000-0000-4000-8000-0000000000a1', PACIENTE = '00000000-0000-4000-8000-0000000000b1';
await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}', 'admin@exemplo.invalid'), ('${PACIENTE}', 'paciente@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADMIN}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true);
  insert into public.jornada_coluna (id, nome, ordem, etapa, origem, sla_min) values
    ('a_confirmar', 'A confirmar', 10, 'agendamento', 'klingo', null), ('confirmado', 'Confirmado', 11, 'agendamento', 'klingo', null), ('em_atendimento', 'Em atendimento', 12, 'depois', 'klingo', null)
    on conflict (id) do nothing;
`);
const hoje = (await um(`select (now() at time zone 'America/Sao_Paulo')::date as d`)).d.toISOString().slice(0, 10);
const ONTEM = (() => { const d = new Date(hoje + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
let mid = 8000, n = 0;
const card = async (data) => (await um(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna) values ($1, $2, 'CSI 1', 'a_confirmar') returning id`, [`SEGREDO-${++n}`, data])).id;
const exame = async (hora, { status = 'atendido', confirm = 'Confirmado', proc = 'US ABDOME', motivo = null } = {}) => {
  const c = await card(ONTEM); const m = `m${++mid}`;
  await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, unidade, agendado_em, agendado_para, status, confirm_status, cancelamento_motivo)
    values ($1, $2, $3, 'CSI 1', ($4::date - 5)::timestamp at time zone 'America/Sao_Paulo', ($4 || ' ' || $5)::timestamp at time zone 'America/Sao_Paulo', $6, $7, $8)`, [c, m, proc, ONTEM, hora, status, confirm, motivo]);
  return { c, m };
};
const t = (hora) => `${ONTEM}T${hora}:00-03:00`;
const A = await exame('09:00');            // com hora real completa
const B = await exame('10:00');            // só chegada aproximada pelo Klingo (evento)
await db.query(`insert into public.jornada_evento (card_id, tipo, origem, para_coluna, quando) values ($1, 'movido', 'klingo', 'em_atendimento', ($2)::timestamptz)`, [B.c, t('09:50')]);
const C = await exame('11:00', { status: 'faltou', confirm: 'Sem Resposta' });
const D = await exame('12:00', { status: 'cancelado', motivo: '  ' });   // cancelado sem motivo
const E_ = await exame('13:00', { status: 'cancelado', motivo: 'Paciente pediu' });

await caso('a tabela da hora real é fechada: anon e logado não leem nem gravam; a gravação é só do servidor', async () => {
  await anonimo(); let a = false; try { await q(`select * from public.atendimento_hora`); } catch { a = true; }
  await como(ADMIN); let b = false; try { await q(`select * from public.atendimento_hora`); } catch { b = true; }
  let c = false; try { await q(`select public.atendimento_hora_gravar('[]'::jsonb)`); } catch { c = true; }
  await como(null);
  return { ok: falhas.length === 0 && a && b && c, detalhe: `anon ${a}, logado ${b}, gravar logado ${c}` };
});

let gravou;
await caso('gravar: aceita as linhas boas e recusa id inválido, hora fora de ordem, exame de mais de 8 h e linha vazia', async () => {
  await db.exec(`reset role; set role service_role;`);
  gravou = (await um(`select public.atendimento_hora_gravar($1::jsonb) as j`, [JSON.stringify([
    { m: A.m, chegada: t('08:50'), inicio: t('09:05'), fim: t('09:35') },
    { m: 'xyz', chegada: t('08:00') },                                   // id inválido
    { m: B.m, inicio: t('10:30'), fim: t('10:10') },                      // fim antes do início
    { m: C.m, inicio: t('08:00'), fim: t('17:00') },                      // 9 h
    { m: E_.m }                                                           // sem nenhuma hora
  ])])).j;
  await como(null);
  const linhas = (await um(`select count(*)::int as n from public.atendimento_hora`)).n;
  return { ok: gravou.gravadas === 1 && gravou.recusadas === 4 && linhas === 1, detalhe: JSON.stringify(gravou) + ` linhas ${linhas}` };
});
await caso('gravar de novo com campo vazio não apaga o que já havia (só completa)', async () => {
  await db.exec(`reset role; set role service_role;`);
  await q(`select public.atendimento_hora_gravar($1::jsonb)`, [JSON.stringify([{ m: A.m, chegada: t('08:45') }, { m: B.m, chegada: t('09:55'), inicio: t('10:05') }])]);
  await como(null);
  const a = await um(`select to_char(chegada_em at time zone 'America/Sao_Paulo', 'HH24:MI') c, to_char(inicio_em at time zone 'America/Sao_Paulo', 'HH24:MI') i, to_char(fim_em at time zone 'America/Sao_Paulo', 'HH24:MI') f from public.atendimento_hora where marcacao_id = $1`, [A.m]);
  return { ok: a.c === '08:45' && a.i === '09:05' && a.f === '09:35', detalhe: JSON.stringify(a) };
});

await como(ADMIN);
const dia = (await um(`select public.painel_simulacao_dia($1::date) as j`, [ONTEM])).j;
const ind = (await um(`select public.painel_simulacao_indicadores(28) as j`)).j;
await como(null);

await caso('simulação: a hora real vira arrive/start/end e vale mais que a chegada aproximada do Klingo', async () => {
  const v = dia.visits;
  const a = v.find((x) => x.slot === 540), b = v.find((x) => x.slot === 600);
  return { ok: a.arrive === 8 * 60 + 45 && a.start === 9 * 60 + 5 && a.end === 9 * 60 + 35 && b.arrive === 9 * 60 + 55 && b.start === 10 * 60 + 5 && b.end === undefined && dia.meta.com_hora_real === 1,
    detalhe: JSON.stringify({ a, b, meta: dia.meta }) };
});
await caso('fim sem início, ou início antes da chegada, não vira etapa (a ordem do contrato é respeitada)', async () => {
  await db.exec(`reset role; set role service_role;`);
  await q(`select public.atendimento_hora_gravar($1::jsonb)`, [JSON.stringify([{ m: B.m, fim: t('10:40') }])]);   // B tem início 10:05, então fim 10:40 vale
  await como(ADMIN);
  const d2 = (await um(`select public.painel_simulacao_dia($1::date) as j`, [ONTEM])).j;
  await como(null);
  const b = d2.visits.find((x) => x.slot === 600);
  return { ok: b.arrive === 595 && b.start === 605 && b.end === 640 && d2.meta.com_hora_real === 2, detalhe: JSON.stringify(b) };
});
await caso('histórico: as durações reais (fim − início) entram por hora, unidade e modalidade', async () => {
  const h = (await (async () => { await como(ADMIN); const r = (await um(`select public.painel_simulacao_dia($1::date) as j`, [hoje])).j; await como(null); return r; })()).history;
  const bin = h.find((x) => x.date === ONTEM && x.hour === 9 && x.type === 'us');
  const bin10 = h.find((x) => x.date === ONTEM && x.hour === 10 && x.type === 'us');
  return { ok: bin && bin.durations.length === 1 && bin.durations[0] === 30 && bin10.durations[0] === 35 && h.every((x) => Array.isArray(x.durations)), detalhe: JSON.stringify({ bin, bin10 }) };
});
await caso('indicadores de pontualidade e calibragem usam a hora real (sem quebrar sem ela)', async () => {
  return { ok: !!ind.pontualidade && ind.unidades.length >= 1, detalhe: JSON.stringify(ind.unidades?.[0]) };
});

let lac;
await caso('lacunas: por situação, pessoas e a % de cada dado; só admin/atendente', async () => {
  await anonimo(); let a = false; try { await q(`select public.painel_simulacao_lacunas(28)`); } catch { a = true; }
  await como(PACIENTE); let p = false; try { await q(`select public.painel_simulacao_lacunas(28)`); } catch { p = true; }
  await como(ADMIN); lac = (await um(`select public.painel_simulacao_lacunas(28) as j`)).j; await como(null);
  const by = Object.fromEntries(lac.linhas.map((l) => [l.status, l]));
  const at = by.atendido, fa = by.faltou, ca = by.cancelado;
  return { ok: a && p && at.marcacoes === 2 && at.pessoas === 2 && at.campos.chegada.de === 2 && at.campos.chegada.com === 2 && at.campos.inicio_fim.com === 2 && at.campos.resultado.com === 0
    && at.campos.telefone.com === 0 && at.campos.confirmacao.com === 2 && fa.campos.chegada.de === null && ca.marcacoes === 2 && ca.campos.motivo.de === 2 && ca.campos.motivo.com === 1,
    detalhe: JSON.stringify({ at: at.campos, ca: ca.campos.motivo, anon: a, pac: p }) };
});
await caso('lacunas: o mapa traz a hora real, a última leitura e nenhum dado pessoal', async () => {
  const txt = JSON.stringify(lac);
  return { ok: lac.hora_real.atendidos === 2 && lac.hora_real.com_inicio_e_fim === 2 && !!lac.hora_real.ultima_leitura && !/SEGREDO|nome|cpf|telefone":"/i.test(txt), detalhe: JSON.stringify(lac.hora_real) };
});
await caso('só leitura: as funções de leitura não alteram nenhuma linha', async () => {
  const antes = await um(`select (select count(*) from public.jornada_exame)::int a, (select count(*) from public.atendimento_hora)::int b`);
  await como(ADMIN); await q(`select public.painel_simulacao_dia(current_date)`); await q(`select public.painel_simulacao_lacunas(28)`); await como(null);
  const depois = await um(`select (select count(*) from public.jornada_exame)::int a, (select count(*) from public.atendimento_hora)::int b`);
  return { ok: antes.a === depois.a && antes.b === depois.b, detalhe: '' };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
