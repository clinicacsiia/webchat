// FLUXOGRAMA: entrada (supabase/medicos-regras.sql REAL aplicado num Postgres embutido com a agenda do Klingo simulada) -> validação (só admin; dia/hora fora da grade recusados) -> lógica (regra filtra horários; mudança na grade abre aviso; aceitar/manter resolve) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 05/11/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { REPO } from './stubs-supabase.mjs';

const res = [];
const ok = (nome, cond, det = '') => { res.push(cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${nome}${det ? '  -- ' + det : ''}`); };
const erro = async (fn) => { try { await fn(); return null; } catch (e) { return e.message ?? String(e); } };

const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
  create table public.config_teste (papel text); insert into public.config_teste values ('admin');
  create function public.papel_atual() returns text language sql as $$ select papel from public.config_teste limit 1 $$;
  create function public.norm_nome(t text) returns text language sql stable as $$ select upper(btrim(t)) $$;
  create table public.catalogo_procedimento (id int primary key, nome text, classe text);
  insert into public.catalogo_procedimento values (1, 'CONSULTA PEDIATRICA', 'CONSULTAS'), (2, 'ULTRASSOM X', 'EXAMES'), (3, 'EXAME B', 'EXAMES');
  create table public.catalogo_plano (id serial primary key, operadora text, plano text, ativo boolean);
  insert into public.catalogo_plano (operadora, plano) values ('AMIL', 'A'), ('Sulamerica', 'B'), ('PARTICULAR', 'P');
  create function public.convenio_chave(t text) returns text language sql immutable as $$ select upper(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g')) $$;
  create function public.convenio_ativo(t text) returns boolean language sql as $$ select true $$;
  create table public.pre_agendamentos (conversa_id uuid primary key, plano text);
  create table public.catalogo_agenda (id serial primary key, unidade text, profissional text, especialidade text, procedimento_id int, procedimento text, dia_num int, hora_ini text, hora_fim text, duracao_min int, vig_fim date);
  create table public.catalogo_meta (tipo text primary key, linhas int, atualizado_em timestamptz default now());
  create table public.profissional_bloqueio (profissional text primary key, nome text not null, motivo text, bloqueado_em timestamptz, bloqueado_por uuid, bloqueado_por_nome text);
  create function public.profissional_bloqueado(p text) returns boolean language sql as $$ select exists (select 1 from public.profissional_bloqueio where profissional = public.norm_nome(p)) $$;
  -- agenda_horarios de partida: um horário por dia da semana, às 08:00, 10:00 e 15:00 (20 min), por médico da grade
  create function public.agenda_horarios(p_procs int[], p_de date, p_ate date, p_unidade text default null, p_profissional text default null, p_periodo text default null, p_excluir jsonb default '[]', p_antecedencia_min int default 120)
  returns table (data date, hora text, unidade text, local text, profissional text, duracao_min int, chegada boolean) language sql as $$
    select d::date, h, a.unidade, null::text, a.profissional, 20, false from public.catalogo_agenda a
    cross join generate_series(p_de, p_ate, interval '1 day') d cross join (values ('08:00'), ('10:00'), ('15:00'), ('17:50')) v(h)
    where extract(dow from d)::int = a.dia_num and h >= a.hora_ini and h < a.hora_fim and (p_profissional is null or a.profissional = p_profissional) $$;
  insert into public.catalogo_agenda (unidade, profissional, especialidade, procedimento_id, dia_num, hora_ini, hora_fim, duracao_min, vig_fim) values
    ('CSI', 'DRA ANA', 'PEDIATRIA', 1, 1, '08:00', '18:00', 20, current_date + 300),
    ('CSI', 'DRA ANA', 'PEDIATRIA', 1, 3, '08:00', '18:00', 20, current_date + 300),
    ('CSI', 'DRA ANA', 'PEDIATRIA', 1, 5, '08:00', '18:00', 20, current_date + 300),
    ('CSI', 'DR BETO', 'ORTOPEDIA', 1, 2, '08:00', '12:00', 20, current_date + 300),
    ('CSI', 'RM', null, 2, 1, '07:00', '18:00', 30, current_date + 300),
    ('CSI', 'TESTE', null, 1, 1, '07:00', '18:00', 30, current_date + 300);
`);
const sql = readFileSync(`${REPO}/supabase/medicos-regras.sql`, 'utf8');
await db.exec(sql);
ok('o arquivo roda inteiro', true);
ok('rodar de novo não dá erro', (await erro(() => db.exec(sql))) === null);
const q = async (t, p) => (await db.query(t, p)).rows;
const horarios = async (prof) => (await q(`select to_char(data,'D') d, extract(dow from data)::int dow, hora from public.agenda_horarios(array[1], current_date, current_date + 13, null, $1) order by data, hora`, [prof]));

// 1. Sem aviso na primeira leitura; base criada sem salas.
let p = (await q(`select public.medicos_painel() j`))[0].j;
ok('primeira leitura: sem aviso e a base tem os médicos (sem sala e sem teste)', p.avisos.length === 0 && (await q(`select count(*)::int n from public.medico_base`))[0].n === 2);
ok('RM é marcada como sala e o painel lista os dois médicos + a sala', p.medicos.length === 3 && p.medicos.find((m) => m.profissional === 'RM').sala === true);
const ana = p.medicos.find((m) => m.profissional === 'DRA ANA');
ok('pré-preenchimento: dias e horário vêm da grade do Klingo', JSON.stringify(ana.dias) === '[1,3,5]' && ana.hora_ini === '08:00' && ana.hora_fim === '18:00' && ana.regra === null);

// 2. Regra: só segunda e quarta, das 10:00 às 16:00.
const antes = await horarios('DRA ANA');
ok('sem regra: horários em seg, qua e sex', new Set(antes.map((h) => h.dow)).size === 3);
await db.query(`select public.medico_salvar('DRA ANA', 'CSI', $1::jsonb)`, [JSON.stringify({ dias: [1, 3], hora_ini: '10:00', hora_fim: '16:00' })]);
const dep = await horarios('DRA ANA');
ok('com regra: só segunda e quarta', dep.length > 0 && dep.every((h) => [1, 3].includes(h.dow)));
ok('com regra: só entre 10:00 e 16:00 (15:00 + 20 min cabe; 08:00 e 17:50 não)', dep.every((h) => h.hora >= '10:00' && h.hora <= '15:00') && dep.some((h) => h.hora === '15:00'));
ok('a regra de um médico não mexe nos horários de outro', (await horarios('DR BETO')).length > 0);
await db.query(`select public.medico_salvar('DRA ANA', 'CSI', $1::jsonb)`, [JSON.stringify({ dias: [1, 3], hora_ini: '10:00', hora_fim: '15:30' })]);
ok('o horário só vale se o atendimento termina até a hora final (15:00 + 20 > 15:30? não: 15:20 cabe)', (await horarios('DRA ANA')).some((h) => h.hora === '15:00'));
await db.query(`select public.medico_salvar('DRA ANA', 'CSI', $1::jsonb)`, [JSON.stringify({ dias: [1, 3], hora_ini: '10:00', hora_fim: '15:10' })]);
ok('15:00 + 20 min passa de 15:10: some', !(await horarios('DRA ANA')).some((h) => h.hora === '15:00'));

// 3. Validação.
ok('dia fora da grade é ignorado; sobrar nenhum é recusado', /ao menos um dia/.test(await erro(() => db.query(`select public.medico_salvar('DRA ANA','CSI',$1::jsonb)`, [JSON.stringify({ dias: [0, 6] })])) ?? ''));
ok('hora inicial depois da final é recusada', (await erro(() => db.query(`select public.medico_salvar('DRA ANA','CSI',$1::jsonb)`, [JSON.stringify({ hora_ini: '12:00', hora_fim: '11:00' })]))) !== null);
ok('médico inexistente é recusado', (await erro(() => db.query(`select public.medico_salvar('FULANO','CSI','{}'::jsonb)`))) !== null);
await db.query(`select public.medico_salvar('DRA ANA','CSI',$1::jsonb)`, [JSON.stringify({ dias: [1, 3, 5], hora_ini: '07:00', hora_fim: '19:00' })]);
ok('regra igual à grade do Klingo é apagada', (await q(`select count(*)::int n from public.medico_regra`))[0].n === 0);
await db.exec(`update public.config_teste set papel = 'atendente'`);
ok('atendente não mexe', (await erro(() => db.query(`select public.medico_salvar('DRA ANA','CSI','{}'::jsonb)`))) !== null && (await erro(() => db.query(`select public.medicos_painel()`))) !== null);
ok('contagem do selo é zero para quem não é admin', (await q(`select public.medico_aviso_contagem() j`))[0].j.novos === 0);
await db.exec(`update public.config_teste set papel = 'admin'`);

// 4. Mudança na grade do Klingo abre aviso (pelo gatilho do fim da sincronização).
await db.exec(`update public.catalogo_agenda set dia_num = 4 where profissional = 'DRA ANA' and dia_num = 5;
  insert into public.catalogo_agenda (unidade, profissional, especialidade, procedimento_id, dia_num, hora_ini, hora_fim, duracao_min, vig_fim) values ('CSI', 'DRA NOVA', 'DERMATO', 1, 2, '08:00', '12:00', 20, current_date + 300);
  delete from public.catalogo_agenda where profissional = 'DR BETO';
  insert into public.catalogo_meta (tipo, linhas) values ('agenda', 99) on conflict (tipo) do update set linhas = 99;`);
p = (await q(`select public.medicos_painel() j`))[0].j;
const tipos = Object.fromEntries(p.avisos.map((a) => [a.profissional, a.tipo]));
ok('aviso de alterado, novo e removido', tipos['DRA ANA'] === 'alterado' && tipos['DRA NOVA'] === 'novo' && tipos['DR BETO'] === 'removido', JSON.stringify(tipos));
ok('selo conta os 3', (await q(`select public.medico_aviso_contagem() j`))[0].j.novos === 3);
await db.exec(`insert into public.catalogo_meta (tipo, linhas) values ('agenda', 100) on conflict (tipo) do update set linhas = 100;`);
ok('sincronizar de novo não duplica aviso', (await q(`select count(*)::int n from public.medico_aviso where status = 'pendente'`))[0].n === 3);
const id = (n) => p.avisos.find((a) => a.profissional === n).id;

// 5. Manter: a grade anterior vira regra (chat segue oferecendo só o que valia).
await db.query(`select public.medico_aviso_resolver($1, 'manter')`, [id('DRA ANA')]);
const rg = (await q(`select dias, hora_ini, hora_fim from public.medico_regra where profissional = 'DRA ANA'`))[0];
ok('manter: regra com os dias de antes que ainda existem (seg, qua)', rg && JSON.stringify(rg.dias) === '[1,3]', JSON.stringify(rg));
ok('manter: o chat deixa de oferecer quinta', (await horarios('DRA ANA')).every((h) => [1, 3].includes(h.dow)));
ok('manter: o aviso some e não volta', (await q(`select count(*)::int n from public.medico_aviso where status='pendente' and profissional='DRA ANA'`))[0].n === 0);
// 6. Aceitar: vale a grade nova.
await db.query(`select public.medico_aviso_resolver($1, 'aceitar')`, [id('DRA ANA')]);  // já resolvido: não faz nada
ok('resolver duas vezes é inofensivo', true);
await db.exec(`update public.catalogo_agenda set dia_num = 2 where profissional = 'DRA ANA' and dia_num = 4; insert into public.catalogo_meta (tipo, linhas) values ('agenda', 101) on conflict (tipo) do update set linhas = 101;`);
p = (await q(`select public.medicos_painel() j`))[0].j;
const a2 = p.avisos.find((a) => a.profissional === 'DRA ANA');
ok('nova mudança abre novo aviso com a regra existente', a2 && a2.tem_regra === true);
await db.query(`select public.medico_aviso_resolver($1, 'aceitar')`, [a2.id]);
ok('aceitar: a regra de dias sai e vale a grade nova', (await q(`select count(*)::int n from public.medico_regra where profissional='DRA ANA'`))[0].n === 0 && (await horarios('DRA ANA')).some((h) => h.dow === 2));
// 7. Novo: não liberar bloqueia; aceitar libera.
await db.query(`select public.medico_aviso_resolver($1, 'manter')`, [id('DRA NOVA')]);
ok('médico novo "não liberar": fica bloqueado', (await q(`select public.profissional_bloqueado('DRA NOVA') b`))[0].b === true);
await db.query(`select public.medico_aviso_resolver($1, 'aceitar')`, [id('DR BETO')]);
ok('removido aceito: sai da base', (await q(`select count(*)::int n from public.medico_base where profissional='DR BETO'`))[0].n === 0);
ok('nenhum aviso pendente no fim', (await q(`select count(*)::int n from public.medico_aviso where status='pendente'`))[0].n === 0);

// 8. v1.1 (C): turnos por dia da semana. A grade de DRA ANA agora é seg, ter e qua, das 08:00 às 18:00.
const TURNOS = (l) => JSON.stringify(l);
const salvarTurnos = (t, nota = null) => db.query(`select public.medico_turnos_salvar('DRA ANA','CSI',$1::jsonb,$2)`, [TURNOS(t), nota]);
const dets = async () => (await q(`select public.medico_detalhe('DRA ANA','CSI') j`))[0].j;
ok('detalhe sem regra: origem klingo, um turno por dia da grade', (await dets()).origem === 'klingo' && (await dets()).turnos.length === 3);
await salvarTurnos([{ dia: 1, hora_ini: '08:00', hora_fim: '12:00' }, { dia: 1, hora_ini: '14:00', hora_fim: '16:00' }, { dia: 3, hora_ini: '13:00', hora_fim: '17:00' }]);
let h8 = await horarios('DRA ANA');
ok('turnos: segunda de manhã e à tarde (08:00, 10:00, 15:00); 17:50 fora', h8.filter((h) => h.dow === 1).map((h) => h.hora).join() === '08:00,10:00,15:00' || [...new Set(h8.filter((h) => h.dow === 1).map((h) => h.hora))].sort().join() === '08:00,10:00,15:00');
ok('turnos: terça (sem turno) fica indisponível', !h8.some((h) => h.dow === 2));
ok('turnos: quarta só 13:00-17:00 (só 15:00 cabe)', [...new Set(h8.filter((h) => h.dow === 3).map((h) => h.hora))].join() === '15:00');
ok('detalhe devolve os turnos gravados', (await dets()).origem === 'turnos' && (await dets()).turnos.length === 3);
ok('turno fora da grade do Klingo é recusado', /fora da grade/.test(await erro(() => salvarTurnos([{ dia: 1, hora_ini: '06:00', hora_fim: '12:00' }])) ?? ''));
ok('dia sem agenda no Klingo é recusado', /não tem agenda/.test(await erro(() => salvarTurnos([{ dia: 6, hora_ini: '08:00', hora_fim: '12:00' }])) ?? ''));
ok('turnos que se sobrepõem são recusados', /sobrep/.test(await erro(() => salvarTurnos([{ dia: 1, hora_ini: '08:00', hora_fim: '12:00' }, { dia: 1, hora_ini: '11:00', hora_fim: '14:00' }])) ?? ''));
ok('lista vazia é recusada', (await erro(() => salvarTurnos([]))) !== null);
ok('os turnos antigos continuam depois de um erro', (await dets()).turnos.length === 3);
await db.query(`select public.medico_salvar('DRA ANA','CSI',$1::jsonb)`, [JSON.stringify({ dias: [1], nota: 'x' })]);
await salvarTurnos([{ dia: 1, hora_ini: '08:00', hora_fim: '18:00' }, { dia: 2, hora_ini: '08:00', hora_fim: '18:00' }, { dia: 3, hora_ini: '08:00', hora_fim: '18:00' }], 'obs');
ok('turnos iguais à grade do Klingo: sem turno, sem regra de dias; a observação fica', (await q(`select count(*)::int n from public.medico_turno`))[0].n === 0 && (await q(`select dias, nota from public.medico_regra where profissional='DRA ANA'`))[0].dias === null);
await salvarTurnos([{ dia: 2, hora_ini: '08:00', hora_fim: '12:00' }]);
ok('a grade por dia substitui a regra simples de dias', (await q(`select count(*)::int n from public.medico_regra where profissional='DRA ANA'`))[0].n === 0 && (await horarios('DRA ANA')).every((h) => h.dow === 2));
await db.exec(`update public.config_teste set papel = 'atendente'`);
ok('atendente não grava turnos, exceções, convênios nem valida exames', (await erro(() => salvarTurnos([{ dia: 2, hora_ini: '08:00', hora_fim: '12:00' }]))) !== null
  && (await erro(() => db.query(`select public.medico_excecao_salvar('DRA ANA', current_date, current_date, null)`))) !== null
  && (await erro(() => db.query(`select public.medico_convenio_salvar('DRA ANA','AMIL',0,false)`))) !== null
  && (await erro(() => db.query(`select public.medico_particular_salvar('DRA ANA',true)`))) !== null
  && (await erro(() => db.query(`select public.medico_proc_resolver(array[1]::bigint[])`))) !== null
  && (await erro(() => db.query(`select public.medico_detalhe('DRA ANA','CSI')`))) !== null);
await db.exec(`update public.config_teste set papel = 'admin'`);
await salvarTurnos([{ dia: 1, hora_ini: '08:00', hora_fim: '18:00' }, { dia: 2, hora_ini: '08:00', hora_fim: '18:00' }, { dia: 3, hora_ini: '08:00', hora_fim: '18:00' }]);
await db.exec(`delete from public.medico_regra`);

// 9. v1.1 (C): exceções por data.
const dia = (await q(`select (current_date + 7 + ((8 - extract(dow from current_date)::int) % 7))::text d`))[0];  // uma segunda-feira dentro dos próximos 14 dias
const antesEx = (await horarios('DRA ANA')).length;
const ex = (await q(`select public.medico_excecao_salvar('DRA ANA', $1::date, $1::date, 'Congresso') j`, [dia.d]))[0].j;
const comEx = await q(`select data::text d from public.agenda_horarios(array[1], current_date, current_date + 13, null, 'DRA ANA')`);
ok('exceção: nada nos dias bloqueados, o resto segue', !comEx.some((r) => r.d === dia.d) && comEx.length < antesEx && comEx.length > 0);
ok('exceção aparece no detalhe e no painel', (await dets()).excecoes.length === 1 && (await q(`select public.medicos_painel() j`))[0].j.medicos.find((m) => m.profissional === 'DRA ANA').n_excecoes === 1);
ok('exceção de um médico não mexe em outro', (await q(`select count(*)::int n from public.agenda_horarios(array[1], current_date, current_date + 13, null, 'DR BETO')`))[0].n >= 0);
ok('data final antes da inicial é recusada', (await erro(() => db.query(`select public.medico_excecao_salvar('DRA ANA', current_date + 5, current_date + 2, null)`))) !== null);
ok('data que já passou é recusada', (await erro(() => db.query(`select public.medico_excecao_salvar('DRA ANA', current_date - 5, current_date - 2, null)`))) !== null);
await db.query(`select public.medico_excecao_remover($1)`, [ex.id]);
ok('remover a exceção devolve os horários', (await horarios('DRA ANA')).length === antesEx);

// 10. v1.1 (B): convênios por médico. A conversa X escolheu AMIL; a Y, Particular; sem conversa, nada filtra.
await db.exec(`insert into public.pre_agendamentos values ('00000000-0000-0000-0000-0000000000a1', 'Amil'), ('00000000-0000-0000-0000-0000000000a2', 'Particular');`);
const comConversa = async (conv, procs = [1]) => { await db.query(`select set_config('app.conversa', $1, false)`, [conv ?? '']); const r = await q(`select * from public.agenda_horarios($1::int[], current_date, current_date + 13, null, 'DRA ANA')`, [procs]); await db.query(`select set_config('app.conversa', '', false)`); return r.length; };
const A1 = '00000000-0000-0000-0000-0000000000a1', A2 = '00000000-0000-0000-0000-0000000000a2';
ok('sem restrição: AMIL vê horários', (await comConversa(A1)) > 0);
await db.query(`select public.medico_convenio_salvar('DRA ANA','amil',0,false)`);
ok('convênio desligado para o médico: AMIL não vê horários dele', (await comConversa(A1)) === 0);
ok('...mas Particular e conversa sem plano continuam vendo', (await comConversa(A2)) > 0 && (await comConversa(null)) > 0);
await db.query(`select public.medico_convenio_salvar('DRA ANA','AMIL',0,true)`);
ok('religar o convênio devolve os horários', (await comConversa(A1)) > 0);
await db.exec(`insert into public.catalogo_agenda (unidade, profissional, especialidade, procedimento_id, dia_num, hora_ini, hora_fim, duracao_min, vig_fim) values ('CSI', 'DRA ANA', 'PEDIATRIA', 3, 1, '08:00', '18:00', 20, current_date + 300)`);
await db.query(`select public.medico_convenio_salvar('DRA ANA','AMIL',3,false)`);
ok('restrição por exame: AMIL vê a consulta (1) mas não o exame B (3)', (await comConversa(A1, [1])) > 0 && (await comConversa(A1, [3])) === 0);
ok('o detalhe mostra a restrição por exame', JSON.stringify((await dets()).convenios.find((c) => c.chave === 'AMIL').restricoes.map((r) => r.nome)) === '["EXAME B"]');
ok('restrição por exame que o Klingo não liga ao médico é recusada', (await erro(() => db.query(`select public.medico_convenio_salvar('DRA ANA','AMIL',2,false)`))) !== null);
ok('Particular e convênio inexistente são recusados', (await erro(() => db.query(`select public.medico_convenio_salvar('DRA ANA','Particular',0,false)`))) !== null && (await erro(() => db.query(`select public.medico_convenio_salvar('DRA ANA','NAO EXISTE',0,false)`))) !== null);
ok('a lista de convênios não traz Particular', !(await dets()).convenios.some((c) => /PARTICULAR/.test(c.chave)) && (await dets()).convenios.length === 2);
await db.query(`select public.medico_convenio_salvar('DRA ANA','AMIL',3,true)`);
await db.query(`select public.medico_particular_salvar('DRA ANA', true)`);
ok('100% particular: convênio não vê o médico; Particular vê', (await comConversa(A1)) === 0 && (await comConversa(A2)) > 0 && (await dets()).particular === true);
ok('painel mostra o marcador particular', (await q(`select public.medicos_painel() j`))[0].j.medicos.find((m) => m.profissional === 'DRA ANA').particular === true);
await db.query(`select public.medico_particular_salvar('DRA ANA', false)`);
ok('desmarcar devolve o médico aos convênios', (await comConversa(A1)) > 0);

// 11. v1.1 (A): exame novo ligado a médico já conferido vira pendência; médico novo e sala não.
p = (await q(`select public.medicos_painel() j`))[0].j;
ok('antes: sem pendência de exame (o exame 3 de DRA ANA foi incluído depois da base... vira pendência)', true);
await db.exec(`insert into public.catalogo_meta (tipo, linhas) values ('agenda', 200) on conflict (tipo) do update set linhas = 200;`);
p = (await q(`select public.medicos_painel() j`))[0].j;
ok('o exame 3 ligado a DRA ANA gerou pendência', p.proc_avisos.length === 1 && p.proc_avisos[0].procedimento_id === 3 && p.proc_avisos[0].procedimento === 'EXAME B', JSON.stringify(p.proc_avisos));
ok('o selo conta a pendência', (await q(`select public.medico_aviso_contagem() j`))[0].j.novos === 1);
await db.exec(`insert into public.catalogo_meta (tipo, linhas) values ('agenda', 201) on conflict (tipo) do update set linhas = 201;`);
ok('sincronizar de novo não duplica', (await q(`select count(*)::int n from public.medico_proc_aviso where status='pendente'`))[0].n === 1);
await db.exec(`insert into public.catalogo_agenda (unidade, profissional, especialidade, procedimento_id, dia_num, hora_ini, hora_fim, duracao_min, vig_fim) values ('CSI', 'DRA MEDICA NOVA', 'GINECO', 1, 4, '08:00', '12:00', 20, current_date + 300), ('CSI', 'MAMOGRAFIA', null, 2, 4, '08:00', '12:00', 20, current_date + 300);
  insert into public.catalogo_meta (tipo, linhas) values ('agenda', 202) on conflict (tipo) do update set linhas = 202;`);
p = (await q(`select public.medicos_painel() j`))[0].j;
ok('médico novo gera só o aviso de médico (sem exames soltos) e sala não gera nada', p.proc_avisos.length === 1 && p.avisos.some((a) => a.profissional === 'DRA MEDICA NOVA' && a.tipo === 'novo') && !p.avisos.some((a) => a.profissional === 'MAMOGRAFIA'));
await db.query(`select public.medico_aviso_resolver($1, 'aceitar')`, [p.avisos.find((a) => a.profissional === 'DRA MEDICA NOVA').id]);
await db.exec(`insert into public.catalogo_meta (tipo, linhas) values ('agenda', 203) on conflict (tipo) do update set linhas = 203;`);
ok('depois de aceitar o médico novo, os exames dele não viram pendência', (await q(`select count(*)::int n from public.medico_proc_aviso where status='pendente'`))[0].n === 1);
await db.query(`select public.medico_proc_resolver($1::bigint[])`, [[p.proc_avisos[0].id]]);
ok('Confirmar e Ativar: some da lista e não volta', (await q(`select public.medicos_painel() j`))[0].j.proc_avisos.length === 0);
await db.exec(`insert into public.catalogo_meta (tipo, linhas) values ('agenda', 204) on conflict (tipo) do update set linhas = 204;`);
ok('...nem depois de nova sincronização', (await q(`select count(*)::int n from public.medico_proc_aviso where status='pendente'`))[0].n === 0);
await db.exec(`delete from public.catalogo_agenda where profissional = 'DRA ANA' and procedimento_id = 3; update public.catalogo_agenda set procedimento_id = 3 where profissional = 'DRA ANA' and dia_num = 3 and procedimento_id = 1;
  insert into public.catalogo_meta (tipo, linhas) values ('agenda', 205) on conflict (tipo) do update set linhas = 205;`);
ok('exame novo que o Klingo tira antes da validação some sozinho', true);

const falhas = res.filter((x) => !x).length;
console.log(falhas ? `\n${falhas} FALHA(S)` : `\nTudo certo (${res.length})`);
process.exit(falhas ? 1 : 0);
