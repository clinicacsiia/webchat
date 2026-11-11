-- public.convenio_demanda()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenio_demanda()
 RETURNS TABLE(chave text, semanas integer[], total integer, ult_30d integer, ant_30d integer, previsao_30d integer, tendencia_pct integer, confiavel boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ini date; v_fim date; v_n int := 0; v_span boolean;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  select (date_trunc('week', min(e.agendado_em)) + interval '1 week')::date, coalesce(min(e.agendado_em) <= now() - interval '60 days', false)
    into v_ini, v_span from public.jornada_exame e where e.agendado_em is not null;
  v_fim := date_trunc('week', now())::date;
  if v_ini is not null and v_ini < v_fim then v_ini := greatest(v_ini, v_fim - 28); v_n := (v_fim - v_ini) / 7; end if;
  return query
  with ops as (select public.convenio_chave(e.operadora) ch from public.jornada_exame e where nullif(btrim(e.operadora), '') is not null group by 1),
  sem as (select g.i, (v_ini + g.i * 7) as ini from generate_series(0, greatest(v_n, 1) - 1) g(i) where v_n > 0),
  cont as (select o.ch, s.i, count(e.id)::int n from ops o cross join sem s
             left join public.jornada_exame e on public.convenio_chave(e.operadora) = o.ch and e.agendado_em >= s.ini and e.agendado_em < s.ini + 7
            group by o.ch, s.i),
  reg as (select c.ch, array_agg(c.n order by c.i) sems, sum(c.n)::int tot, regr_slope(c.n::float8, c.i::float8) b, regr_intercept(c.n::float8, c.i::float8) a, count(*)::int k from cont c group by c.ch),
  rec as (select public.convenio_chave(e.operadora) ch,
            (count(*) filter (where e.agendado_em >= now() - interval '30 days'))::int u30,
            (count(*) filter (where e.agendado_em >= now() - interval '60 days' and e.agendado_em < now() - interval '30 days'))::int a30
          from public.jornada_exame e where nullif(btrim(e.operadora), '') is not null group by 1)
  select o.ch, coalesce(r.sems, '{}'::int[]), coalesce(r.tot, 0), coalesce(rc.u30, 0), coalesce(rc.a30, 0),
    case when coalesce(r.k, 0) >= 4 and coalesce(r.tot, 0) >= 8 then least(greatest(0, round(4.29 * (r.a + r.b * (r.k + 1.65)))), greatest(2 * coalesce(rc.u30, 0), 10))::int else coalesce(rc.u30, 0) end,
    case when v_span and coalesce(rc.a30, 0) > 0 then round((coalesce(rc.u30, 0) - rc.a30) * 100.0 / rc.a30)::int end,
    (coalesce(r.k, 0) >= 4 and coalesce(r.tot, 0) >= 8)
  from ops o left join reg r on r.ch = o.ch left join rec rc on rc.ch = o.ch;
end $function$;

