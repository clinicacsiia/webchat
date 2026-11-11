-- public.agenda_horarios_klingo_v1(p_procs integer[], p_de date, p_ate date, p_unidade text, p_profissional text, p_periodo text, p_excluir jsonb, p_antecedencia_min integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_horarios_klingo_v1(p_procs integer[], p_de date, p_ate date, p_unidade text DEFAULT NULL::text, p_profissional text DEFAULT NULL::text, p_periodo text DEFAULT NULL::text, p_excluir jsonb DEFAULT '[]'::jsonb, p_antecedencia_min integer DEFAULT 120)
 RETURNS TABLE(data date, hora text, unidade text, local text, profissional text, duracao_min integer, chegada boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare
  v_agora timestamp := (now() at time zone 'America/Bahia');
  v_valido timestamptz;
  v_n integer;
begin
  select m.valido_desde into v_valido from public.agenda_ocupacao_meta m where m.id = 1;
  select count(distinct x) into v_n from unnest(p_procs) x;
  if coalesce(v_n, 0) = 0 or p_de is null or p_ate is null or p_ate - p_de > 62 then return; end if;

  return query
  with grade as (
    select a.unidade, a.local, a.profissional, a.dia_num, a.hora_ini, a.hora_fim, a.duracao_min, a.vig_ini, a.vig_fim
    from public.catalogo_agenda a
    join public.catalogo_procedimento pm on pm.id = a.procedimento_id
    left join public.agenda_modalidade_local ml on ml.modalidade = pm.modalidade
    where a.procedimento_id = any(p_procs) and (ml.local_padrao is null or a.local ~* ml.local_padrao) and a.profissional !~* 'teste' and not public.profissional_bloqueado(a.profissional) and a.vig_fim >= p_de and a.vig_ini <= p_ate
      and (p_unidade is null or public.norm_nome(a.unidade) = public.norm_nome(p_unidade))
      and (p_profissional is null or public.norm_nome(a.profissional) = public.norm_nome(p_profissional))
    group by a.unidade, a.local, a.profissional, a.dia_num, a.hora_ini, a.hora_fim, a.duracao_min, a.vig_ini, a.vig_fim
    having count(distinct a.procedimento_id) = v_n
  ), janelas as (
    select g.*, d.dia::date as dia, (d.dia::date + g.hora_ini::time) as ini_ts, (d.dia::date + g.hora_fim::time) as fim_ts,
           (g.duracao_min <= 5) as e_chegada,
           (select sum(coalesce(rg.minutos, greatest(g.duracao_min, 10))) from unnest(p_procs) u(id)
              join public.catalogo_procedimento p on p.id = u.id left join public.agenda_regra_duracao rg on rg.modalidade = p.modalidade)::int as need
    from grade g
    join generate_series(p_de, p_ate, interval '1 day') d(dia) on extract(dow from d.dia)::int = g.dia_num and d.dia::date between g.vig_ini and g.vig_fim
    where not (g.duracao_min <= 5 and (g.hora_fim::time - g.hora_ini::time) < interval '60 minutes')
  ), nativos as (
    select j.unidade, j.local, j.profissional, j.dia, j.hora_ini, j.hora_fim, j.duracao_min, j.need, j.fim_ts, s.t
    from janelas j
    cross join lateral generate_series(j.ini_ts, j.fim_ts - make_interval(mins => j.duracao_min), make_interval(mins => j.duracao_min)) s(t)
    where not j.e_chegada
  ), reservas as (
    select * from public.agenda_reservas_provisorias(nullif(current_setting('app.conversa', true), '')::uuid)
  ), estado as (
    select n.*, not exists (
        select 1 from public.agenda_ocupacao o
        where o.unidade = public.norm_nome(n.unidade) and (v_valido is null or o.visto_em >= v_valido)
          and (o.profissional = public.norm_nome(n.profissional) or (o.local is not null and o.local = n.local))
          and o.inicio < n.t + make_interval(mins => n.duracao_min)
          and o.inicio + make_interval(mins => coalesce(o.reserva_min, n.duracao_min)) > n.t)
        and not exists (select 1 from reservas r where r.unidade = public.norm_nome(n.unidade)
          and (r.profissional = public.norm_nome(n.profissional) or (r.local is not null and r.local = n.local))
          and r.inicio < n.t + make_interval(mins => n.duracao_min) and r.fim > n.t) as livre
    from nativos n
  ), validos as (
    select e.* from estado e
    where e.livre
      and e.t + make_interval(mins => e.need) <= e.fim_ts
      and e.t > v_agora + make_interval(mins => p_antecedencia_min)
      and not exists (select 1 from estado e2
                      where e2.unidade = e.unidade and e2.local is not distinct from e.local and e2.profissional = e.profissional and e2.dia = e.dia
                        and e2.hora_ini = e.hora_ini and e2.hora_fim = e.hora_fim and not e2.livre
                        and e2.t < e.t + make_interval(mins => e.need) and e2.t + make_interval(mins => e2.duracao_min) > e.t)
      and not exists (select 1 from jsonb_to_recordset(p_excluir) x(data date, hora text, min integer, unidade text)
                      where (x.data + x.hora::time) - make_interval(mins => case when x.unidade is not null and public.norm_nome(x.unidade) <> public.norm_nome(e.unidade) then 60 else 15 end) < e.t + make_interval(mins => e.need)
                        and (x.data + x.hora::time) + make_interval(mins => x.min + case when x.unidade is not null and public.norm_nome(x.unidade) <> public.norm_nome(e.unidade) then 60 else 15 end) > e.t)
      and (p_periodo is null or (p_periodo = 'manha' and e.t::time < time '12:00') or (p_periodo = 'tarde' and e.t::time >= time '12:00' and e.t::time < time '18:00')
           or (p_periodo = 'noite' and e.t::time >= time '18:00'))
  ), blocos as (
    select distinct on (v.unidade, v.local, v.profissional, v.dia,
             floor((extract(hour from v.t) * 60 + extract(minute from v.t)) /
               (case when v.need > v.duracao_min then (case when v.need <= 20 then 20 else 30 end) else greatest(v.duracao_min, 15) end)))
      v.dia, to_char(v.t, 'HH24:MI') as hora, v.unidade, v.local, v.profissional, v.need as duracao_min, false as chegada, v.t
    from validos v
    order by v.unidade, v.local, v.profissional, v.dia,
             floor((extract(hour from v.t) * 60 + extract(minute from v.t)) /
               (case when v.need > v.duracao_min then (case when v.need <= 20 then 20 else 30 end) else greatest(v.duracao_min, 15) end)), v.t
  ), chegadas as (
    select j.dia, to_char(j.ini_ts, 'HH24:MI') as hora, j.unidade, j.local, j.profissional, 0 as duracao_min, true as chegada, j.ini_ts as t
    from janelas j
    where j.e_chegada and j.fim_ts > v_agora + make_interval(mins => p_antecedencia_min)
      and (p_periodo is null or (p_periodo = 'manha' and j.ini_ts::time < time '12:00') or (p_periodo = 'tarde' and j.ini_ts::time >= time '12:00' and j.ini_ts::time < time '18:00')
           or (p_periodo = 'noite' and j.ini_ts::time >= time '18:00'))
  )
  select u.dia, u.hora, u.unidade, u.local, u.profissional, u.duracao_min::int, u.chegada
  from (select b.dia, b.hora, b.unidade, b.local, b.profissional, b.duracao_min, b.chegada, b.t from blocos b
        union all select c.dia, c.hora, c.unidade, c.local, c.profissional, c.duracao_min, c.chegada, c.t from chegadas c) u
  order by u.dia, u.hora, u.profissional;
end $function$;

