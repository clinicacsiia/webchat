-- FLUXOGRAMA: entrada (aba "Médicos" do painel; sincronização do Klingo que troca a grade de agenda) -> validação (só administrador mexe; o dia e a hora têm de estar dentro da grade do Klingo) -> lógica (a regra do médico é um FILTRO por cima da grade do Klingo: dias e faixa de horário permitidos; a grade que o Klingo mandou da última vez que a equipe conferiu fica em medico_base; quando a nova grade difere, nasce um aviso pendente até a equipe aceitar ou manter) -> saída (o chat só oferece horário que passa na regra; selo no menu enquanto houver aviso pendente)
-- Versão 1.2 — 05/11/2026 / Mudança: mapa de salas (só leitura): consultório x dia x horário vindo da agenda do Klingo, com aviso quando horários se sobrepõem. Não bloqueia nada.
-- Versão 1.1 — 05/11/2026 / Mudança: três módulos na aba Médicos — (A) pendência de validação quando o Klingo liga um exame novo a um médico, (B) convênios por médico (liga/desliga, restrição por exame, 100% particular), (C) grade por dia da semana com mais de um turno e exceções por data (folga, congresso, feriado). Motivo: a recepção precisa validar e ajustar cada médico sem depender do Klingo.
-- Versão 1.0 — 05/11/2026 / Implementação inicial: dias e faixa de horário por médico (medico_regra).
-- Depende também de (para a v1.1): convenios-e-foto.sql (convenio_chave, convenio_ativo), catalogo_plano e pre_agendamentos (plano da conversa; o chat grava a conversa em app.conversa antes de pedir horários).
-- Reaplicar a v1.1 em produção: seções 1, 2, 3 e 4 de novo, em partes (tudo é 'create or replace' / 'if not exists').
--
-- Depende de: catalogo-klingo.sql, catalogo-historico*.sql (catalogo_meta, catalogo_agenda), fase2-pedido-e-agenda.sql (agenda_horarios), pacientes.sql (norm_nome) e agenda-medica-bloqueio.sql (profissional_bloqueio: liga/desliga o médico no chat).
-- Aplicar em PARTES (o Supabase expira a migração em 60 s): parte 1 = seção 1; parte 2 = seção 2; parte 3 = seção 3; parte 4 = seção 4.
-- Sem 'drop' no arquivo: o Supabase pede confirmação e a migração expira. ROLLBACK (rodar à mão): drop trigger medico_detectar_meta on public.catalogo_meta; e, para o chat voltar a ler só a grade: alter function public.agenda_horarios(...) rename para agenda_horarios_regras e
-- alter function public.agenda_horarios_klingo(...) rename para agenda_horarios. As tabelas medico_* podem ficar.
-- Nenhum dado de paciente entra aqui.

-- ===== 1. Tabelas =====
create table if not exists public.medico_regra (
  profissional text not null,          -- nome como vem do Klingo
  unidade text not null,               -- unidade como vem do Klingo
  dias integer[],                      -- dias permitidos (0 = domingo ... 6 = sábado); null = todos os dias da grade
  hora_ini text,                       -- 'HH:MM': não oferecer horário antes disso; null = sem limite
  hora_fim text,                       -- 'HH:MM': o atendimento tem de terminar até isso; null = sem limite
  nota text,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid,
  primary key (profissional, unidade),
  check (dias is null or cardinality(dias) > 0),
  check (hora_ini is null or hora_ini ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  check (hora_fim is null or hora_fim ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  check (hora_ini is null or hora_fim is null or hora_ini < hora_fim)
);
alter table public.medico_regra enable row level security;
revoke all on public.medico_regra from anon, authenticated;
comment on table public.medico_regra is 'Particularidades de cada médico (dias e faixa de horário) como filtro sobre a grade do Klingo. Não é apagada pela sincronização.';

create table if not exists public.medico_base (
  profissional text not null,
  unidade text not null,
  dias integer[] not null,
  hora_ini text not null,
  hora_fim text not null,
  conferido_em timestamptz not null default now(),
  primary key (profissional, unidade)
);
alter table public.medico_base enable row level security;
revoke all on public.medico_base from anon, authenticated;
comment on table public.medico_base is 'Grade do Klingo (por médico e unidade) na última vez em que a equipe conferiu. A diferença para a grade atual vira aviso.';

create table if not exists public.medico_aviso (
  id bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  profissional text not null,
  unidade text not null,
  tipo text not null check (tipo in ('novo', 'alterado', 'removido')),
  antes jsonb,
  depois jsonb,
  status text not null default 'pendente' check (status in ('pendente', 'aceito', 'mantido', 'automatico')),
  resolvido_em timestamptz,
  resolvido_por uuid
);
create unique index if not exists medico_aviso_pendente_idx on public.medico_aviso (profissional, unidade) where status = 'pendente';
alter table public.medico_aviso enable row level security;
revoke all on public.medico_aviso from anon, authenticated;

-- ===== 1b. Tabelas da v1.1 =====
-- (C) Turnos por dia da semana. Se o médico/unidade tem ao menos um turno aqui, SÓ vale o que está dentro de um turno (sempre dentro da grade do Klingo).
create table if not exists public.medico_turno (
  profissional text not null,
  unidade text not null,
  dia integer not null check (dia between 0 and 6),
  hora_ini text not null check (hora_ini ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  hora_fim text not null check (hora_fim ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  atualizado_em timestamptz not null default now(),
  primary key (profissional, unidade, dia, hora_ini),
  check (hora_ini < hora_fim)
);
alter table public.medico_turno enable row level security;
revoke all on public.medico_turno from anon, authenticated;

-- (C) Exceções: datas em que o médico não atende (folga, congresso, feriado particular). Vale para todas as unidades. profissional = norm_nome.
create table if not exists public.medico_excecao (
  id bigint generated always as identity primary key,
  profissional text not null,
  data_ini date not null,
  data_fim date not null,
  motivo text,
  criado_em timestamptz not null default now(),
  criado_por uuid,
  check (data_fim >= data_ini)
);
create index if not exists medico_excecao_prof_idx on public.medico_excecao (profissional, data_fim);
alter table public.medico_excecao enable row level security;
revoke all on public.medico_excecao from anon, authenticated;

-- (B) Convênios que o médico NÃO aceita. Sem linha = aceita. procedimento_id 0 = todos os exames; > 0 = só aquele exame. operadora = convenio_chave. profissional = norm_nome.
create table if not exists public.medico_convenio_bloqueio (
  profissional text not null,
  operadora text not null,
  procedimento_id integer not null default 0,
  criado_em timestamptz not null default now(),
  criado_por uuid,
  primary key (profissional, operadora, procedimento_id)
);
alter table public.medico_convenio_bloqueio enable row level security;
revoke all on public.medico_convenio_bloqueio from anon, authenticated;

-- (B) Médico 100% particular: o chat só o oferece a quem escolheu Particular.
create table if not exists public.medico_particular (
  profissional text primary key,           -- norm_nome
  criado_em timestamptz not null default now(),
  criado_por uuid
);
alter table public.medico_particular enable row level security;
revoke all on public.medico_particular from anon, authenticated;

-- (A) Exames/especialidades que o Klingo já ligou a cada médico na última conferência, e as pendências de validação.
create table if not exists public.medico_proc_base (
  profissional text not null,
  procedimento_id integer not null,
  conferido_em timestamptz not null default now(),
  primary key (profissional, procedimento_id)
);
alter table public.medico_proc_base enable row level security;
revoke all on public.medico_proc_base from anon, authenticated;

create table if not exists public.medico_proc_aviso (
  id bigint generated always as identity primary key,
  criado_em timestamptz not null default now(),
  profissional text not null,
  procedimento_id integer not null,
  procedimento text,
  especialidade text,
  status text not null default 'pendente' check (status in ('pendente', 'ativo', 'automatico')),
  resolvido_em timestamptz,
  resolvido_por uuid
);
create unique index if not exists medico_proc_aviso_pendente_idx on public.medico_proc_aviso (profissional, procedimento_id) where status = 'pendente';
alter table public.medico_proc_aviso enable row level security;
revoke all on public.medico_proc_aviso from anon, authenticated;

-- ===== 2. Grade do Klingo por médico, regra efetiva e detecção de mudança =====
-- Grade vigente por médico e unidade. "sala" = equipamento ou sala (RM, TC, RX, ultrassonografia...), que não é médico.
create or replace function public.medico_klingo()
returns table (profissional text, unidade text, especialidade text, consulta boolean, sala boolean, dias integer[], hora_ini text, hora_fim text)
language sql stable security definer set search_path to '' as $$
  select a.profissional, a.unidade,
         string_agg(distinct initcap(lower(a.especialidade)), ' / '),
         coalesce(bool_or(p.classe = 'CONSULTAS'), false),
         (a.profissional ~* '^((rm|tc|rx)$|mamografia|densitometria|ultrassonografia|eletro)'),
         array_agg(distinct a.dia_num order by a.dia_num),
         min(a.hora_ini), max(a.hora_fim)
  from public.catalogo_agenda a left join public.catalogo_procedimento p on p.id = a.procedimento_id
  where a.vig_fim >= current_date and a.profissional !~* 'teste' and a.dia_num is not null and a.hora_ini is not null and a.hora_fim is not null
  group by a.profissional, a.unidade
$$;
revoke all on function public.medico_klingo() from public, anon, authenticated;

-- Grava (ou apaga) a regra de um médico já comparada com a grade do Klingo: o que for igual à grade vira "sem limite".
create or replace function public.medico_regra_gravar(p_prof text, p_unid text, p_dias integer[], p_ini text, p_fim text, p_nota text)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare k record; v_dias integer[]; v_ini text := nullif(btrim(p_ini), ''); v_fim text := nullif(btrim(p_fim), ''); v_nota text := nullif(left(btrim(coalesce(p_nota, '')), 200), '');
begin
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = public.norm_nome(p_prof) and public.norm_nome(m.unidade) = public.norm_nome(p_unid);
  if not found then raise exception 'Médico ou unidade não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  if p_dias is not null then
    select coalesce(array_agg(distinct d order by d), '{}') into v_dias from unnest(p_dias) d where d = any(k.dias);
    if cardinality(v_dias) = 0 then raise exception 'Marque ao menos um dia em que o médico atende, ou bloqueie o médico.' using errcode = '22023'; end if;
    if v_dias = k.dias then v_dias := null; end if;
  end if;
  if v_ini is not null and v_ini !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Hora inicial inválida.' using errcode = '22023'; end if;
  if v_fim is not null and v_fim !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Hora final inválida.' using errcode = '22023'; end if;
  if v_ini is not null and v_fim is not null and v_ini >= v_fim then raise exception 'A hora inicial tem de ser antes da final.' using errcode = '22023'; end if;
  if v_ini is not null and v_ini <= k.hora_ini then v_ini := null; end if;
  if v_fim is not null and v_fim >= k.hora_fim then v_fim := null; end if;
  if v_ini is not null and v_ini >= k.hora_fim then raise exception 'A hora inicial fica depois do fim da grade do Klingo (%).', k.hora_fim using errcode = '22023'; end if;
  if v_fim is not null and v_fim <= k.hora_ini then raise exception 'A hora final fica antes do início da grade do Klingo (%).', k.hora_ini using errcode = '22023'; end if;
  if v_dias is null and v_ini is null and v_fim is null and v_nota is null then
    delete from public.medico_regra where public.norm_nome(profissional) = public.norm_nome(k.profissional) and public.norm_nome(unidade) = public.norm_nome(k.unidade);
    return jsonb_build_object('regra', false);
  end if;
  insert into public.medico_regra (profissional, unidade, dias, hora_ini, hora_fim, nota, atualizado_em, atualizado_por)
    values (k.profissional, k.unidade, v_dias, v_ini, v_fim, v_nota, now(), (select auth.uid()))
    on conflict (profissional, unidade) do update set dias = excluded.dias, hora_ini = excluded.hora_ini, hora_fim = excluded.hora_fim, nota = excluded.nota, atualizado_em = now(), atualizado_por = excluded.atualizado_por;
  return jsonb_build_object('regra', true, 'dias', v_dias, 'hora_ini', v_ini, 'hora_fim', v_fim);
end $$;
revoke all on function public.medico_regra_gravar(text, text, integer[], text, text, text) from public, anon, authenticated;

-- O que mudou entre a base conferida e a grade atual (sem salas).
create or replace function public.medico_diferencas()
returns table (profissional text, unidade text, tipo text, antes jsonb, depois jsonb)
language sql stable security definer set search_path to '' as $$
  select coalesce(k.profissional, b.profissional), coalesce(k.unidade, b.unidade),
         case when b.profissional is null then 'novo' when k.profissional is null then 'removido' else 'alterado' end,
         case when b.profissional is null then null else jsonb_build_object('dias', b.dias, 'hora_ini', b.hora_ini, 'hora_fim', b.hora_fim) end,
         case when k.profissional is null then null else jsonb_build_object('dias', k.dias, 'hora_ini', k.hora_ini, 'hora_fim', k.hora_fim) end
  from (select * from public.medico_klingo() x where not x.sala) k
  full join public.medico_base b on public.norm_nome(b.profissional) = public.norm_nome(k.profissional) and public.norm_nome(b.unidade) = public.norm_nome(k.unidade)
  where b.profissional is null or k.profissional is null or (b.dias, b.hora_ini, b.hora_fim) is distinct from (k.dias, k.hora_ini, k.hora_fim)
$$;
revoke all on function public.medico_diferencas() from public, anon, authenticated;

-- (A) Pares médico x exame/consulta que o Klingo tem agora (sem salas e sem teste).
create or replace function public.medico_procs_klingo()
returns table (profissional text, procedimento_id integer, procedimento text, especialidade text)
language sql stable security definer set search_path to '' as $$
  select a.profissional, a.procedimento_id, min(coalesce(p.nome, a.procedimento)), min(initcap(lower(a.especialidade)))
  from public.catalogo_agenda a left join public.catalogo_procedimento p on p.id = a.procedimento_id
  where a.vig_fim >= current_date and a.profissional !~* 'teste' and a.procedimento_id is not null and a.dia_num is not null and a.hora_ini is not null and a.hora_fim is not null
    and a.profissional !~* '^((rm|tc|rx)$|mamografia|densitometria|ultrassonografia|eletro)'
  group by a.profissional, a.procedimento_id
$$;
revoke all on function public.medico_procs_klingo() from public, anon, authenticated;

-- (A) Exame novo ligado a um médico que a equipe já conferiu = pendência de validação. Na primeira vez só guarda a base. Médico novo não entra aqui: o aviso dele já cobre tudo.
create or replace function public.medico_detectar_procs() returns integer
language plpgsql security definer set search_path to '' as $$
declare n integer := 0;
begin
  if not exists (select 1 from public.medico_proc_base) then
    insert into public.medico_proc_base (profissional, procedimento_id) select k.profissional, k.procedimento_id from public.medico_procs_klingo() k on conflict do nothing;
    return 0;
  end if;
  insert into public.medico_proc_aviso (profissional, procedimento_id, procedimento, especialidade)
    select k.profissional, k.procedimento_id, k.procedimento, k.especialidade from public.medico_procs_klingo() k
    where exists (select 1 from public.medico_base b where public.norm_nome(b.profissional) = public.norm_nome(k.profissional))
      and not exists (select 1 from public.medico_proc_base x where public.norm_nome(x.profissional) = public.norm_nome(k.profissional) and x.procedimento_id = k.procedimento_id)
    on conflict (profissional, procedimento_id) where status = 'pendente' do nothing;
  get diagnostics n = row_count;
  update public.medico_proc_aviso a set status = 'automatico', resolvido_em = now()
    where a.status = 'pendente' and not exists (select 1 from public.medico_procs_klingo() k where public.norm_nome(k.profissional) = public.norm_nome(a.profissional) and k.procedimento_id = a.procedimento_id);
  return n;
end $$;
revoke all on function public.medico_detectar_procs() from public, anon, authenticated;

-- Compara a grade atual do Klingo com a última conferida e abre/atualiza/fecha os avisos. Na primeira vez só guarda a base (sem aviso).
create or replace function public.medico_detectar() returns integer
language plpgsql security definer set search_path to '' as $$
declare n integer;
begin
  perform pg_advisory_xact_lock(hashtext('medico_detectar'));
  if not exists (select 1 from public.catalogo_agenda) then return 0; end if;
  if not exists (select 1 from public.medico_base) then
    insert into public.medico_base (profissional, unidade, dias, hora_ini, hora_fim)
      select k.profissional, k.unidade, k.dias, k.hora_ini, k.hora_fim from public.medico_klingo() k where not k.sala;
    perform public.medico_detectar_procs();
    return 0;
  end if;
  insert into public.medico_aviso (profissional, unidade, tipo, antes, depois)
    select d.profissional, d.unidade, d.tipo, d.antes, d.depois from public.medico_diferencas() d
    on conflict (profissional, unidade) where status = 'pendente'
    do update set tipo = excluded.tipo, antes = excluded.antes, depois = excluded.depois;
  get diagnostics n = row_count;
  update public.medico_aviso a set status = 'automatico', resolvido_em = now()
    where a.status = 'pendente' and not exists (select 1 from public.medico_diferencas() m where m.profissional = a.profissional and m.unidade = a.unidade);
  perform public.medico_detectar_procs();
  return n;
end $$;
revoke all on function public.medico_detectar() from public, anon, authenticated;

create or replace function public.medico_detectar_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  if new.tipo = 'agenda' then perform public.medico_detectar(); end if;
  return null;
end $$;
revoke all on function public.medico_detectar_trg() from public, anon, authenticated;
-- A sincronização troca a grade e só no fim grava catalogo_meta: é nesse ponto que a grade nova já está no banco.
create or replace trigger medico_detectar_meta after insert or update on public.catalogo_meta for each row execute function public.medico_detectar_trg();

-- ===== 3. O chat só oferece horário que passa na regra =====
-- A função de horários que o chat já usa (com o bloqueio de médico) passa a se chamar agenda_horarios_klingo; a nova agenda_horarios chama a antiga e tira o que a regra não permite.
do $$
begin
  if to_regprocedure('public.agenda_horarios_klingo(integer[],date,date,text,text,text,jsonb,integer)') is null then
    alter function public.agenda_horarios(integer[], date, date, text, text, text, jsonb, integer) rename to agenda_horarios_klingo;
  end if;
end $$;
revoke all on function public.agenda_horarios_klingo(integer[], date, date, text, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.agenda_horarios_klingo(integer[], date, date, text, text, text, jsonb, integer) to service_role;

create or replace function public.agenda_horarios(
  p_procs integer[], p_de date, p_ate date, p_unidade text default null, p_profissional text default null,
  p_periodo text default null, p_excluir jsonb default '[]'::jsonb, p_antecedencia_min integer default 120)
returns table (data date, hora text, unidade text, local text, profissional text, duracao_min integer, chegada boolean)
language sql stable security definer set search_path to '' as $$
  with ctx as (
    -- Convênio da conversa (o chat grava a conversa em app.conversa antes de pedir horários). Vazio ou Particular = sem filtro de convênio.
    select case when public.convenio_chave(pa.plano) ~ '^(|PARTICULAR.*)$' then null else public.convenio_chave(pa.plano) end as op
    from (select 1) u left join public.pre_agendamentos pa on pa.conversa_id = nullif(current_setting('app.conversa', true), '')::uuid
  )
  select h.data, h.hora, h.unidade, h.local, h.profissional, h.duracao_min, h.chegada
  from public.agenda_horarios_klingo(p_procs, p_de, p_ate, p_unidade, p_profissional, p_periodo, p_excluir, p_antecedencia_min) h, ctx
  where not exists (
    select 1 from public.medico_regra r
    where public.norm_nome(r.profissional) = public.norm_nome(h.profissional) and public.norm_nome(r.unidade) = public.norm_nome(h.unidade)
      and ((r.dias is not null and not (extract(dow from h.data)::int = any(r.dias)))
        or (r.hora_ini is not null and h.hora < r.hora_ini)
        or (r.hora_fim is not null and (h.hora::time + make_interval(mins => case when h.chegada then 0 else h.duracao_min end)) > r.hora_fim::time)))
    -- (C) Turnos por dia: com turnos cadastrados, o horário tem de caber inteiro em um deles.
    and (not exists (select 1 from public.medico_turno t where public.norm_nome(t.profissional) = public.norm_nome(h.profissional) and public.norm_nome(t.unidade) = public.norm_nome(h.unidade))
      or exists (select 1 from public.medico_turno t
                 where public.norm_nome(t.profissional) = public.norm_nome(h.profissional) and public.norm_nome(t.unidade) = public.norm_nome(h.unidade)
                   and t.dia = extract(dow from h.data)::int and h.hora >= t.hora_ini
                   and (h.hora::time + make_interval(mins => case when h.chegada then 0 else h.duracao_min end)) <= t.hora_fim::time))
    -- (C) Exceções: folga, congresso, feriado do médico.
    and not exists (select 1 from public.medico_excecao e where e.profissional = public.norm_nome(h.profissional) and h.data between e.data_ini and e.data_fim)
    -- (B) 100% particular e convênios que o médico não aceita (geral ou só para um exame do pedido).
    and (ctx.op is null or (
      not exists (select 1 from public.medico_particular mp where mp.profissional = public.norm_nome(h.profissional))
      and not exists (select 1 from public.medico_convenio_bloqueio b
                      where b.profissional = public.norm_nome(h.profissional) and b.operadora = ctx.op and (b.procedimento_id = 0 or b.procedimento_id = any(p_procs)))))
$$;
revoke all on function public.agenda_horarios(integer[], date, date, text, text, text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.agenda_horarios(integer[], date, date, text, text, text, jsonb, integer) to service_role;

-- ===== 4. Funções do painel (só administrador) =====
create or replace function public.medicos_painel() returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  perform public.medico_detectar();
  return jsonb_build_object(
    'medicos', coalesce((select jsonb_agg(to_jsonb(q) order by q.sala, q.profissional, q.unidade) from (
      select k.profissional, k.unidade, k.especialidade, k.consulta, k.sala, k.dias, k.hora_ini, k.hora_fim,
             (select to_jsonb(r) - 'atualizado_por' from public.medico_regra r where public.norm_nome(r.profissional) = public.norm_nome(k.profissional) and public.norm_nome(r.unidade) = public.norm_nome(k.unidade)) as regra,
             public.profissional_bloqueado(k.profissional) as bloqueado,
             exists (select 1 from public.medico_turno t where public.norm_nome(t.profissional) = public.norm_nome(k.profissional) and public.norm_nome(t.unidade) = public.norm_nome(k.unidade)) as tem_turnos,
             exists (select 1 from public.medico_particular mp where mp.profissional = public.norm_nome(k.profissional)) as particular,
             (select count(*)::int from public.medico_convenio_bloqueio b where b.profissional = public.norm_nome(k.profissional)) as n_convenios_fora,
             (select count(*)::int from public.medico_excecao e where e.profissional = public.norm_nome(k.profissional) and e.data_fim >= current_date) as n_excecoes,
             (select a.id from public.medico_aviso a where a.status = 'pendente' and a.profissional = k.profissional and a.unidade = k.unidade) as aviso_id
      from public.medico_klingo() k) q), '[]'::jsonb),
    'avisos', coalesce((select jsonb_agg(to_jsonb(a) - 'resolvido_por' order by a.criado_em desc, a.id desc) from (
      select a.id, a.criado_em, a.profissional, a.unidade, a.tipo, a.antes, a.depois, a.status, a.resolvido_em,
             exists (select 1 from public.medico_regra r where public.norm_nome(r.profissional) = public.norm_nome(a.profissional) and public.norm_nome(r.unidade) = public.norm_nome(a.unidade)) as tem_regra
      from public.medico_aviso a where a.status = 'pendente') a), '[]'::jsonb),
    'proc_avisos', coalesce((select jsonb_agg(to_jsonb(x) order by x.profissional, x.procedimento) from (
      select a.id, a.criado_em, a.profissional, a.procedimento_id, a.procedimento, a.especialidade
      from public.medico_proc_aviso a where a.status = 'pendente' order by a.profissional, a.procedimento limit 600) x), '[]'::jsonb));
end $$;

create or replace function public.medico_salvar(p_profissional text, p_unidade text, p_dados jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_dias integer[];
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  if p_dados ? 'dias' and jsonb_typeof(p_dados -> 'dias') = 'array' then
    select array_agg(x::int) into v_dias from jsonb_array_elements_text(p_dados -> 'dias') x;
  end if;
  return public.medico_regra_gravar(p_profissional, p_unidade, v_dias, p_dados ->> 'hora_ini', p_dados ->> 'hora_fim', p_dados ->> 'nota');
end $$;

create or replace function public.medico_aviso_resolver(p_id bigint, p_acao text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare a public.medico_aviso; k record; r public.medico_regra; v_dias integer[]; v_ini text; v_fim text; v_status text;
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
  if p_acao not in ('aceitar', 'manter') then raise exception 'Ação desconhecida.' using errcode = '22023'; end if;
  select * into a from public.medico_aviso where id = p_id for update;
  if not found or a.status <> 'pendente' then return jsonb_build_object('ok', true, 'ja_resolvido', true); end if;
  select * into k from public.medico_klingo() m where m.profissional = a.profissional and m.unidade = a.unidade;
  select * into r from public.medico_regra where profissional = a.profissional and unidade = a.unidade;

  if a.tipo = 'removido' or k.profissional is null then
    delete from public.medico_base where profissional = a.profissional and unidade = a.unidade;
    delete from public.medico_regra where profissional = a.profissional and unidade = a.unidade;
    delete from public.medico_turno where profissional = a.profissional and unidade = a.unidade;
  else
    insert into public.medico_base (profissional, unidade, dias, hora_ini, hora_fim, conferido_em) values (k.profissional, k.unidade, k.dias, k.hora_ini, k.hora_fim, now())
      on conflict (profissional, unidade) do update set dias = excluded.dias, hora_ini = excluded.hora_ini, hora_fim = excluded.hora_fim, conferido_em = now();
    if p_acao = 'aceitar' then
      -- Vale a grade nova do Klingo: a regra de dias e horas sai (a observação fica).
      if r.profissional is not null then perform public.medico_regra_gravar(k.profissional, k.unidade, null, null, null, r.nota); end if;
      delete from public.medico_turno where profissional = a.profissional and unidade = a.unidade;
    elsif a.tipo = 'novo' then
      -- "Não liberar": o médico novo não aparece no chat até a equipe liberar.
      insert into public.profissional_bloqueio (profissional, nome, motivo, bloqueado_em, bloqueado_por) values (public.norm_nome(k.profissional), k.profissional, 'Médico novo na agenda: não liberado pela equipe', now(), (select auth.uid()))
        on conflict (profissional) do nothing;
    elsif r.profissional is null then
      -- "Manter como estava": a grade anterior vira regra, para o chat seguir oferecendo só o que valia antes.
      select array_agg(x::int) into v_dias from jsonb_array_elements_text(a.antes -> 'dias') x;
      v_ini := a.antes ->> 'hora_ini'; v_fim := a.antes ->> 'hora_fim';
      begin
        perform public.medico_regra_gravar(k.profissional, k.unidade, v_dias, v_ini, v_fim, null);
      exception when others then null;  -- a grade anterior não cabe mais na nova: fica a nova
      end;
    end if;
  end if;

  -- Médico novo: os exames dele já foram vistos junto com o aviso do médico (sem pendência separada).
  if a.tipo = 'novo' and k.profissional is not null then
    insert into public.medico_proc_base (profissional, procedimento_id) select p.profissional, p.procedimento_id from public.medico_procs_klingo() p
      where public.norm_nome(p.profissional) = public.norm_nome(a.profissional) on conflict do nothing;
  end if;
  v_status := case when p_acao = 'aceitar' then 'aceito' else 'mantido' end;
  update public.medico_aviso set status = v_status, resolvido_em = now(), resolvido_por = (select auth.uid()) where id = p_id;
  return jsonb_build_object('ok', true, 'status', v_status);
end $$;

create or replace function public.medico_aviso_contagem() returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('novos', case when (select public.papel_atual()) = 'admin'
    then (select count(*) from public.medico_aviso where status = 'pendente') + (select count(distinct profissional) from public.medico_proc_aviso where status = 'pendente') else 0 end)
$$;

revoke all on function public.medicos_painel() from public, anon;
revoke all on function public.medico_salvar(text, text, jsonb) from public, anon;
revoke all on function public.medico_aviso_resolver(bigint, text) from public, anon;
revoke all on function public.medico_aviso_contagem() from public, anon;
grant execute on function public.medicos_painel() to authenticated;
grant execute on function public.medico_salvar(text, text, jsonb) to authenticated;
grant execute on function public.medico_aviso_resolver(bigint, text) to authenticated;
grant execute on function public.medico_aviso_contagem() to authenticated;

-- ===== 5. v1.1: detalhe do médico, turnos por dia, exceções, convênios e validação de exames (só administrador) =====
create or replace function public.medico_admin() returns void
language plpgsql stable security definer set search_path to '' as $$
begin
  if (select public.papel_atual()) is distinct from 'admin' then raise exception 'Somente administrador.' using errcode = '42501'; end if;
end $$;
revoke all on function public.medico_admin() from public, anon, authenticated;

-- Tudo de um médico numa chamada: turnos (do que vale hoje: turnos > regra antiga > grade do Klingo), exceções futuras, convênios e exames dele.
create or replace function public.medico_detalhe(p_prof text, p_unid text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare k record; r public.medico_regra; v_origem text; v_turnos jsonb; pn text := public.norm_nome(p_prof); v_pm integer[]; v_pu integer[];
begin
  perform public.medico_admin();
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = pn and public.norm_nome(m.unidade) = public.norm_nome(p_unid);
  if not found then raise exception 'Médico ou unidade não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  select * into r from public.medico_regra x where public.norm_nome(x.profissional) = pn and public.norm_nome(x.unidade) = public.norm_nome(p_unid);
  select coalesce(jsonb_agg(jsonb_build_object('dia', t.dia, 'hora_ini', t.hora_ini, 'hora_fim', t.hora_fim) order by t.dia, t.hora_ini), '[]'::jsonb) into v_turnos
    from public.medico_turno t where public.norm_nome(t.profissional) = pn and public.norm_nome(t.unidade) = public.norm_nome(p_unid);
  -- Exames ligados ao médico e à unidade na agenda do Klingo: base dos filtros "deste médico" e "da unidade" na lista de convênios.
  select coalesce(array_agg(distinct a.procedimento_id), '{}') into v_pm from public.catalogo_agenda a
    where public.norm_nome(a.profissional) = pn and a.vig_fim >= current_date and a.procedimento_id is not null;
  select coalesce(array_agg(distinct a.procedimento_id), '{}') into v_pu from public.catalogo_agenda a
    where public.norm_nome(a.unidade) = public.norm_nome(p_unid) and a.vig_fim >= current_date and a.procedimento_id is not null;
  if jsonb_array_length(v_turnos) > 0 then v_origem := 'turnos';
  else
    v_origem := case when r.profissional is null then 'klingo' else 'regra' end;
    select coalesce(jsonb_agg(jsonb_build_object('dia', d, 'hora_ini', coalesce(r.hora_ini, k.hora_ini), 'hora_fim', coalesce(r.hora_fim, k.hora_fim)) order by d), '[]'::jsonb) into v_turnos
      from unnest(coalesce(r.dias, k.dias)) d where d = any(k.dias);
  end if;
  return jsonb_build_object(
    'origem', v_origem, 'turnos', v_turnos, 'nota', r.nota,
    'grade', jsonb_build_object('dias', k.dias, 'hora_ini', k.hora_ini, 'hora_fim', k.hora_fim),
    'n_procs_unidade', cardinality(v_pu),
    'particular', exists (select 1 from public.medico_particular mp where mp.profissional = pn),
    'excecoes', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'data_ini', e.data_ini, 'data_fim', e.data_fim, 'motivo', e.motivo) order by e.data_ini)
                          from public.medico_excecao e where e.profissional = pn and e.data_fim >= current_date), '[]'::jsonb),
    'convenios', coalesce((select jsonb_agg(jsonb_build_object('chave', o.ch, 'nome', o.nome, 'ativo_global', public.convenio_ativo(o.nome),
          'fora', exists (select 1 from public.medico_convenio_bloqueio b where b.profissional = pn and b.operadora = o.ch and b.procedimento_id = 0),
          -- Cobertura inferida das tabelas de preço do convênio no Klingo (catalogo_preco): o convênio tem preço para quantos exames do médico / da unidade.
          'procs_medico', coalesce((select jsonb_agg(distinct c.procedimento_id) from public.catalogo_preco c
                                    where public.convenio_chave(c.operadora) = o.ch and c.fonte = 'convenio' and c.removido_em is null and c.procedimento_id = any(v_pm)), '[]'::jsonb),
          'n_unidade', (select count(distinct c.procedimento_id) from public.catalogo_preco c
                        where public.convenio_chave(c.operadora) = o.ch and c.fonte = 'convenio' and c.removido_em is null and c.procedimento_id = any(v_pu)),
          'restricoes', coalesce((select jsonb_agg(jsonb_build_object('procedimento_id', b.procedimento_id, 'nome', coalesce(pr.nome, 'Exame ' || b.procedimento_id)) order by pr.nome)
                                  from public.medico_convenio_bloqueio b left join public.catalogo_procedimento pr on pr.id = b.procedimento_id
                                  where b.profissional = pn and b.operadora = o.ch and b.procedimento_id > 0), '[]'::jsonb)) order by o.nome)
        from (select public.convenio_chave(operadora) ch, min(operadora) nome from public.catalogo_plano
              where nullif(btrim(operadora), '') is not null and operadora !~* '^(teste|particular.*)$' group by 1) o), '[]'::jsonb),
    'procs', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'nome', q.nome, 'consulta', q.consulta) order by q.consulta desc, q.nome) from (
        select a.procedimento_id as id, min(coalesce(p.nome, a.procedimento)) as nome, bool_or(p.classe = 'CONSULTAS') as consulta
        from public.catalogo_agenda a left join public.catalogo_procedimento p on p.id = a.procedimento_id
        where public.norm_nome(a.profissional) = pn and a.vig_fim >= current_date and a.procedimento_id is not null group by a.procedimento_id) q), '[]'::jsonb));
end $$;

-- (C) Grava os turnos por dia: [{dia, hora_ini, hora_fim}, ...]. Dia sem turno = indisponível. Igual à grade do Klingo = sem regra.
create or replace function public.medico_turnos_salvar(p_prof text, p_unid text, p_turnos jsonb, p_nota text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare k record; t record; v_n integer := 0; v_dias integer; v_igual boolean; v_nota text := nullif(left(btrim(coalesce(p_nota, '')), 200), '');
        nomes text[] := array['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
begin
  perform public.medico_admin();
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = public.norm_nome(p_prof) and public.norm_nome(m.unidade) = public.norm_nome(p_unid);
  if not found then raise exception 'Médico ou unidade não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  if p_turnos is null or jsonb_typeof(p_turnos) <> 'array' then raise exception 'Turnos inválidos.' using errcode = '22023'; end if;
  if jsonb_array_length(p_turnos) > 28 then raise exception 'Turnos demais.' using errcode = '22023'; end if;
  for t in select (x ->> 'dia')::int as dia, nullif(btrim(x ->> 'hora_ini'), '') as hi, nullif(btrim(x ->> 'hora_fim'), '') as hf from jsonb_array_elements(p_turnos) x loop
    if t.dia is null or t.dia < 0 or t.dia > 6 then raise exception 'Dia inválido.' using errcode = '22023'; end if;
    if not (t.dia = any(k.dias)) then raise exception 'O Klingo não tem agenda na %.', nomes[t.dia + 1] using errcode = '22023'; end if;
    if t.hi is null or t.hf is null or t.hi !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or t.hf !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Horário inválido na %.', nomes[t.dia + 1] using errcode = '22023'; end if;
    if t.hi >= t.hf then raise exception 'Na %, a hora inicial tem de ser antes da final.', nomes[t.dia + 1] using errcode = '22023'; end if;
    if t.hi < k.hora_ini or t.hf > k.hora_fim then raise exception 'Na %, o turno % às % fica fora da grade do Klingo (% às %).', nomes[t.dia + 1], t.hi, t.hf, k.hora_ini, k.hora_fim using errcode = '22023'; end if;
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'Marque ao menos um turno, ou bloqueie o médico no chat.' using errcode = '22023'; end if;
  if exists (select 1 from jsonb_to_recordset(p_turnos) a(dia int, hora_ini text, hora_fim text) join jsonb_to_recordset(p_turnos) b(dia int, hora_ini text, hora_fim text) on a.dia = b.dia
             where a.hora_ini < b.hora_fim and b.hora_ini < a.hora_fim and (a.hora_ini, a.hora_fim) <> (b.hora_ini, b.hora_fim)) then
    raise exception 'Há turnos que se sobrepõem no mesmo dia.' using errcode = '22023';
  end if;
  select count(distinct x.dia), bool_and(x.hora_ini = k.hora_ini and x.hora_fim = k.hora_fim) into v_dias, v_igual from jsonb_to_recordset(p_turnos) x(dia int, hora_ini text, hora_fim text);
  v_igual := v_igual and v_dias = cardinality(k.dias) and (select count(distinct (x.dia, x.hora_ini)) from jsonb_to_recordset(p_turnos) x(dia int, hora_ini text, hora_fim text)) = v_dias;
  delete from public.medico_turno where public.norm_nome(profissional) = public.norm_nome(k.profissional) and public.norm_nome(unidade) = public.norm_nome(k.unidade);
  if not v_igual then
    insert into public.medico_turno (profissional, unidade, dia, hora_ini, hora_fim)
      select distinct k.profissional, k.unidade, x.dia, x.hora_ini, x.hora_fim from jsonb_to_recordset(p_turnos) x(dia int, hora_ini text, hora_fim text);
  end if;
  -- A grade por dia substitui a regra simples de dias e horas; a observação fica.
  perform public.medico_regra_gravar(k.profissional, k.unidade, null, null, null, v_nota);
  return jsonb_build_object('regra', not v_igual);
end $$;

-- (C) Exceções por data.
create or replace function public.medico_excecao_salvar(p_prof text, p_ini date, p_fim date, p_motivo text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare k record; v_id bigint;
begin
  perform public.medico_admin();
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = public.norm_nome(p_prof) limit 1;
  if not found then raise exception 'Médico não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  if p_ini is null then raise exception 'Informe a data.' using errcode = '22023'; end if;
  p_fim := coalesce(p_fim, p_ini);
  if p_fim < p_ini then raise exception 'A data final tem de ser igual ou depois da inicial.' using errcode = '22023'; end if;
  if p_fim < current_date then raise exception 'Essa data já passou.' using errcode = '22023'; end if;
  if p_fim - p_ini > 365 then raise exception 'Período longo demais (máximo 1 ano).' using errcode = '22023'; end if;
  insert into public.medico_excecao (profissional, data_ini, data_fim, motivo, criado_por)
    values (public.norm_nome(k.profissional), p_ini, p_fim, nullif(left(btrim(coalesce(p_motivo, '')), 120), ''), (select auth.uid())) returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

create or replace function public.medico_excecao_remover(p_id bigint) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  perform public.medico_admin();
  delete from public.medico_excecao where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- (B) Liga/desliga um convênio para o médico. p_proc nulo ou 0 = todos os exames; senão só aquele exame. p_aceita = false grava a restrição.
create or replace function public.medico_convenio_salvar(p_prof text, p_operadora text, p_proc integer, p_aceita boolean) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare k record; v_op text := public.convenio_chave(p_operadora); v_proc integer := coalesce(p_proc, 0);
begin
  perform public.medico_admin();
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = public.norm_nome(p_prof) limit 1;
  if not found then raise exception 'Médico não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  if v_op ~ '^(|PARTICULAR.*)$' then raise exception 'Particular não tem restrição: o médico sempre atende particular. Para atender só particular, use a chave "100%% particular".' using errcode = '22023'; end if;
  if not exists (select 1 from public.catalogo_plano where public.convenio_chave(operadora) = v_op) then raise exception 'Convênio não encontrado.' using errcode = '22023'; end if;
  if v_proc < 0 then raise exception 'Exame inválido.' using errcode = '22023'; end if;
  if v_proc > 0 and not exists (select 1 from public.catalogo_agenda a where public.norm_nome(a.profissional) = public.norm_nome(k.profissional) and a.procedimento_id = v_proc) then
    raise exception 'O Klingo não liga esse exame a este médico.' using errcode = '22023';
  end if;
  if p_aceita then
    delete from public.medico_convenio_bloqueio where profissional = public.norm_nome(k.profissional) and operadora = v_op and procedimento_id = v_proc;
  else
    insert into public.medico_convenio_bloqueio (profissional, operadora, procedimento_id, criado_por) values (public.norm_nome(k.profissional), v_op, v_proc, (select auth.uid())) on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- (B) Marcador 100% particular.
create or replace function public.medico_particular_salvar(p_prof text, p_valor boolean) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare k record;
begin
  perform public.medico_admin();
  select * into k from public.medico_klingo() m where public.norm_nome(m.profissional) = public.norm_nome(p_prof) limit 1;
  if not found then raise exception 'Médico não encontrado na agenda do Klingo.' using errcode = '22023'; end if;
  if p_valor then insert into public.medico_particular (profissional, criado_por) values (public.norm_nome(k.profissional), (select auth.uid())) on conflict do nothing;
  else delete from public.medico_particular where profissional = public.norm_nome(k.profissional); end if;
  return jsonb_build_object('particular', coalesce(p_valor, false));
end $$;

-- (A) "Confirmar e Ativar": a equipe validou os exames novos do médico. (Ajustar regras = editar o médico e confirmar depois.)
create or replace function public.medico_proc_resolver(p_ids bigint[]) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare n integer;
begin
  perform public.medico_admin();
  insert into public.medico_proc_base (profissional, procedimento_id, conferido_em)
    select a.profissional, a.procedimento_id, now() from public.medico_proc_aviso a where a.id = any(p_ids) and a.status = 'pendente' on conflict (profissional, procedimento_id) do update set conferido_em = now();
  update public.medico_proc_aviso set status = 'ativo', resolvido_em = now(), resolvido_por = (select auth.uid()) where id = any(p_ids) and status = 'pendente';
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'ativados', n);
end $$;

revoke all on function public.medico_detalhe(text, text) from public, anon;
revoke all on function public.medico_turnos_salvar(text, text, jsonb, text) from public, anon;
revoke all on function public.medico_excecao_salvar(text, date, date, text) from public, anon;
revoke all on function public.medico_excecao_remover(bigint) from public, anon;
revoke all on function public.medico_convenio_salvar(text, text, integer, boolean) from public, anon;
revoke all on function public.medico_particular_salvar(text, boolean) from public, anon;
revoke all on function public.medico_proc_resolver(bigint[]) from public, anon;
grant execute on function public.medico_detalhe(text, text) to authenticated;
grant execute on function public.medico_turnos_salvar(text, text, jsonb, text) to authenticated;
grant execute on function public.medico_excecao_salvar(text, date, date, text) to authenticated;
grant execute on function public.medico_excecao_remover(bigint) to authenticated;
grant execute on function public.medico_convenio_salvar(text, text, integer, boolean) to authenticated;
grant execute on function public.medico_particular_salvar(text, boolean) to authenticated;
grant execute on function public.medico_proc_resolver(bigint[]) to authenticated;

-- ===== 6. v1.2: mapa de salas (só leitura; nada é bloqueado) =====
-- Janelas de cada médico em cada consultório, direto da agenda do Klingo (muda sozinho quando o Klingo muda). Janelas coladas ou repetidas do mesmo médico viram uma só.
-- 'choque' = outros médicos no mesmo consultório, dia e horário; 'duplo' = o mesmo médico em dois consultórios ao mesmo tempo. É só aviso para a equipe olhar a tela.
create or replace function public.medicos_mapa_salas() returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  perform public.medico_admin();
  return coalesce((
    with w as (
      select distinct a.unidade, a.local, a.profissional, a.dia_num, a.hora_ini, a.hora_fim
      from public.catalogo_agenda a
      where a.vig_fim >= current_date and a.profissional !~* 'teste' and nullif(btrim(a.local), '') is not null and a.dia_num is not null and a.hora_ini is not null and a.hora_fim is not null
        and a.profissional !~* '^((rm|tc|rx)$|mamografia|densitometria|ultrassonografia|eletro)'
    ), o as (
      select w.*, max(w.hora_fim) over (partition by w.unidade, w.local, w.profissional, w.dia_num order by w.hora_ini, w.hora_fim rows between unbounded preceding and 1 preceding) as mx from w
    ), g as (
      select o.*, sum(case when o.mx is null or o.hora_ini > o.mx then 1 else 0 end) over (partition by o.unidade, o.local, o.profissional, o.dia_num order by o.hora_ini, o.hora_fim) as grp from o
    ), m as (
      select g.unidade, g.local, g.profissional, g.dia_num as dia, min(g.hora_ini) as ini, max(g.hora_fim) as fim from g group by g.unidade, g.local, g.profissional, g.dia_num, g.grp
    )
    select jsonb_agg(jsonb_build_object(
      'unidade', m.unidade, 'local', m.local, 'dia', m.dia, 'ini', m.ini, 'fim', m.fim, 'profissional', m.profissional,
      'bloqueado', public.profissional_bloqueado(m.profissional),
      'choque', coalesce((select jsonb_agg(distinct x.profissional) from m x where x.unidade = m.unidade and x.local = m.local and x.dia = m.dia and x.profissional <> m.profissional and x.ini < m.fim and m.ini < x.fim), '[]'::jsonb),
      'duplo', exists (select 1 from m x where x.unidade = m.unidade and x.profissional = m.profissional and x.dia = m.dia and x.local <> m.local and x.ini < m.fim and m.ini < x.fim))
      order by m.unidade, m.local, m.dia, m.ini, m.profissional)
    from m), '[]'::jsonb);
end $$;
revoke all on function public.medicos_mapa_salas() from public, anon;
grant execute on function public.medicos_mapa_salas() to authenticated;
