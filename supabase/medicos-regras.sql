-- FLUXOGRAMA: entrada (aba "Médicos" do painel; sincronização do Klingo que troca a grade de agenda) -> validação (só administrador mexe; o dia e a hora têm de estar dentro da grade do Klingo) -> lógica (a regra do médico é um FILTRO por cima da grade do Klingo: dias e faixa de horário permitidos; a grade que o Klingo mandou da última vez que a equipe conferiu fica em medico_base; quando a nova grade difere, nasce um aviso pendente até a equipe aceitar ou manter) -> saída (o chat só oferece horário que passa na regra; selo no menu enquanto houver aviso pendente)
-- Versão 1.0 — 05/11/2026 / Mudança: Implementação inicial. Motivo: cada médico tem particularidades (só segunda e quarta, só de tal hora a tal hora) que o Klingo não reflete sozinho.
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
    return 0;
  end if;
  insert into public.medico_aviso (profissional, unidade, tipo, antes, depois)
    select d.profissional, d.unidade, d.tipo, d.antes, d.depois from public.medico_diferencas() d
    on conflict (profissional, unidade) where status = 'pendente'
    do update set tipo = excluded.tipo, antes = excluded.antes, depois = excluded.depois;
  get diagnostics n = row_count;
  update public.medico_aviso a set status = 'automatico', resolvido_em = now()
    where a.status = 'pendente' and not exists (select 1 from public.medico_diferencas() m where m.profissional = a.profissional and m.unidade = a.unidade);
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
  select h.data, h.hora, h.unidade, h.local, h.profissional, h.duracao_min, h.chegada
  from public.agenda_horarios_klingo(p_procs, p_de, p_ate, p_unidade, p_profissional, p_periodo, p_excluir, p_antecedencia_min) h
  where not exists (
    select 1 from public.medico_regra r
    where public.norm_nome(r.profissional) = public.norm_nome(h.profissional) and public.norm_nome(r.unidade) = public.norm_nome(h.unidade)
      and ((r.dias is not null and not (extract(dow from h.data)::int = any(r.dias)))
        or (r.hora_ini is not null and h.hora < r.hora_ini)
        or (r.hora_fim is not null and (h.hora::time + make_interval(mins => case when h.chegada then 0 else h.duracao_min end)) > r.hora_fim::time)))
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
             (select a.id from public.medico_aviso a where a.status = 'pendente' and a.profissional = k.profissional and a.unidade = k.unidade) as aviso_id
      from public.medico_klingo() k) q), '[]'::jsonb),
    'avisos', coalesce((select jsonb_agg(to_jsonb(a) - 'resolvido_por' order by a.criado_em desc, a.id desc) from (
      select a.id, a.criado_em, a.profissional, a.unidade, a.tipo, a.antes, a.depois, a.status, a.resolvido_em,
             exists (select 1 from public.medico_regra r where public.norm_nome(r.profissional) = public.norm_nome(a.profissional) and public.norm_nome(r.unidade) = public.norm_nome(a.unidade)) as tem_regra
      from public.medico_aviso a where a.status = 'pendente') a), '[]'::jsonb));
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
  else
    insert into public.medico_base (profissional, unidade, dias, hora_ini, hora_fim, conferido_em) values (k.profissional, k.unidade, k.dias, k.hora_ini, k.hora_fim, now())
      on conflict (profissional, unidade) do update set dias = excluded.dias, hora_ini = excluded.hora_ini, hora_fim = excluded.hora_fim, conferido_em = now();
    if p_acao = 'aceitar' then
      -- Vale a grade nova do Klingo: a regra de dias e horas sai (a observação fica).
      if r.profissional is not null then perform public.medico_regra_gravar(k.profissional, k.unidade, null, null, null, r.nota); end if;
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

  v_status := case when p_acao = 'aceitar' then 'aceito' else 'mantido' end;
  update public.medico_aviso set status = v_status, resolvido_em = now(), resolvido_por = (select auth.uid()) where id = p_id;
  return jsonb_build_object('ok', true, 'status', v_status);
end $$;

create or replace function public.medico_aviso_contagem() returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_build_object('novos', case when (select public.papel_atual()) = 'admin' then (select count(*) from public.medico_aviso where status = 'pendente') else 0 end)
$$;

revoke all on function public.medicos_painel() from public, anon;
revoke all on function public.medico_salvar(text, text, jsonb) from public, anon;
revoke all on function public.medico_aviso_resolver(bigint, text) from public, anon;
revoke all on function public.medico_aviso_contagem() from public, anon;
grant execute on function public.medicos_painel() to authenticated;
grant execute on function public.medico_salvar(text, text, jsonb) to authenticated;
grant execute on function public.medico_aviso_resolver(bigint, text) to authenticated;
grant execute on function public.medico_aviso_contagem() to authenticated;
