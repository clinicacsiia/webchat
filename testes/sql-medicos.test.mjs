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
  create table public.catalogo_procedimento (id int primary key, classe text);
  insert into public.catalogo_procedimento values (1, 'CONSULTAS'), (2, 'EXAMES');
  create table public.catalogo_agenda (id serial primary key, unidade text, profissional text, especialidade text, procedimento_id int, dia_num int, hora_ini text, hora_fim text, duracao_min int, vig_fim date);
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

const falhas = res.filter((x) => !x).length;
console.log(falhas ? `\n${falhas} FALHA(S)` : `\nTudo certo (${res.length})`);
process.exit(falhas ? 1 : 0);
