-- public.painel_simulacao_indicadores(p_dias integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_simulacao_indicadores(p_dias integer DEFAULT 28)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_dias integer := greatest(7, least(coalesce(p_dias, 28), 90));
  v_de timestamptz; v_ate timestamptz; v_fut timestamptz;
  v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem a simulação.' using errcode = '42501';
  end if;
  v_de := (v_hoje - v_dias)::timestamp at time zone 'America/Sao_Paulo';
  v_ate := v_hoje::timestamp at time zone 'America/Sao_Paulo';
  v_fut := (v_hoje + 15)::timestamp at time zone 'America/Sao_Paulo';

  with base as (
    select e.id, e.card_id, e.status, e.confirm_status, e.agendado_em, e.agendado_para,
           public.sim_unidade(e.unidade) as u, public.sim_modalidade(e.procedimento) as t,
           (e.agendado_para at time zone 'America/Sao_Paulo')::date as d,
           extract(hour from e.agendado_para at time zone 'America/Sao_Paulo')::int as h,
           extract(isodow from e.agendado_para at time zone 'America/Sao_Paulo')::int as dow
      from public.jornada_exame e
     where e.marcacao_id like 'm%' and e.agendado_para >= v_de and e.agendado_para < v_fut
  ),
  pas as (select * from base where agendado_para < v_ate),
  fut as (select * from base where agendado_para >= v_ate),
  fechados as (select * from pas where status in ('atendido', 'faltou') and u is not null and t is not null),
  taxa as (
    select coalesce(confirm_status, 'x') as c, count(*) as n, count(*) filter (where status = 'faltou') as f,
           round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) as pct
      from fechados group by 1
  ),
  geral as (select round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) as pct from fechados),
  cheg as (
    select b.u, b.t, b.h, (extract(hour from c.q at time zone 'America/Sao_Paulo') * 60 + extract(minute from c.q at time zone 'America/Sao_Paulo')
           - (extract(hour from b.agendado_para at time zone 'America/Sao_Paulo') * 60 + extract(minute from b.agendado_para at time zone 'America/Sao_Paulo')))::numeric as delta
      from fechados b join lateral (select min(v.quando) as q from public.jornada_evento v where v.card_id = b.card_id and v.para_coluna = 'em_atendimento' and v.origem = 'klingo') c on c.q is not null
     where b.status = 'atendido' and (c.q at time zone 'America/Sao_Paulo')::date = b.d
  )
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', v_hoje - v_dias, 'ate', v_hoje - 1, 'dias', v_dias,
        'dias_com_dado', (select count(distinct d) from pas), 'primeiro_dia_do_banco', (select min(d) from base)),
    'unidades', (select coalesce(jsonb_agg(jsonb_build_object('unidade', u, 'marcadas', total, 'atendidas', att, 'faltaram', fal, 'canceladas', can, 'remarcadas', rem,
            'pct_falta', round(100.0 * fal / nullif(att + fal, 0), 1), 'pct_cancela_remarca', round(100.0 * (can + rem) / nullif(total, 0), 1)) order by u), '[]'::jsonb)
        from (select u, count(*) as total, count(*) filter (where status = 'atendido') as att, count(*) filter (where status = 'faltou') as fal,
                     count(*) filter (where status = 'cancelado') as can, count(*) filter (where status = 'remarcado') as rem
                from pas where u is not null group by u) z),
    'modalidades', (select coalesce(jsonb_agg(jsonb_build_object('unidade', u, 'tipo', t, 'n', n, 'dias', dias, 'por_dia', round(n::numeric / nullif(dias, 0), 1), 'pct_falta', pct) order by u, n desc), '[]'::jsonb)
        from (select u, t, count(*) as n, count(distinct d) as dias,
                     round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) as pct
                from fechados group by u, t) z),
    'confirmacao', (select coalesce(jsonb_agg(jsonb_build_object('situacao', c, 'n', n, 'faltaram', f, 'pct_falta', pct) order by n desc), '[]'::jsonb) from taxa),
    'semana', (select coalesce(jsonb_agg(jsonb_build_object('dow', dow, 'unidade', u, 'media_por_dia', round(n::numeric / nullif(dias, 0), 1), 'dias', dias, 'pct_falta', pct) order by dow, u), '[]'::jsonb)
        from (select dow, u, count(*) as n, count(distinct d) as dias, round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) as pct
                from fechados group by dow, u) z),
    'horas', (select coalesce(jsonb_agg(jsonb_build_object('hora', h, 'unidade', u, 'media_por_dia', round(n::numeric / nullif(dias, 0), 1), 'pct_falta', pct, 'dias', dias) order by u, h), '[]'::jsonb)
        from (select h, u, count(*) as n, count(distinct d) as dias, round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) as pct
                from fechados group by h, u) z),
    'pontualidade', (select coalesce(jsonb_agg(jsonb_build_object('unidade', u, 'n', n, 'p10', round(p10::numeric, 0), 'p50', round(p50::numeric, 0), 'p90', round(p90::numeric, 0),
            'pct_15_antes', pa, 'pct_15_depois', pd) order by u), '[]'::jsonb)
        from (select u, count(*) as n,
                     percentile_cont(0.1) within group (order by greatest(-120, least(120, delta))) as p10,
                     percentile_cont(0.5) within group (order by greatest(-120, least(120, delta))) as p50,
                     percentile_cont(0.9) within group (order by greatest(-120, least(120, delta))) as p90,
                     round(100.0 * count(*) filter (where delta <= -15) / count(*), 1) as pa, round(100.0 * count(*) filter (where delta >= 15) / count(*), 1) as pd
                from cheg where u is not null group by u having count(*) >= 20) z),
    'antecedencia', (select jsonb_build_object('n', count(*),
            'p50_dias', round((percentile_cont(0.5) within group (order by extract(epoch from (agendado_para - agendado_em)) / 86400))::numeric, 1),
            'p90_dias', round((percentile_cont(0.9) within group (order by extract(epoch from (agendado_para - agendado_em)) / 86400))::numeric, 1),
            'pct_menos_de_1_dia', round(100.0 * count(*) filter (where agendado_para - agendado_em < interval '1 day') / nullif(count(*), 0), 1))
        from pas where agendado_em is not null and agendado_em < agendado_para),
    'proximos', (select coalesce(jsonb_agg(jsonb_build_object('dia', d, 'unidade', u, 'marcadas', n, 'confirmadas', conf, 'a_confirmar', ac, 'sem_resposta', sr,
            'faltas_esperadas', round(esp::numeric, 1)) order by d, u), '[]'::jsonb)
        from (select f.d, f.u, count(*) as n,
                     count(*) filter (where f.confirm_status = 'Confirmado') as conf, count(*) filter (where f.confirm_status = 'A Confirmar') as ac,
                     count(*) filter (where f.confirm_status = 'Sem Resposta') as sr,
                     sum(coalesce(tx.pct, (select g.pct from geral g)) / 100.0) as esp
                from fut f left join taxa tx on tx.c = coalesce(f.confirm_status, 'x')
               where f.u is not null and f.t is not null and f.status in ('agendado', 'confirmado', 'atendido') group by f.d, f.u) z),
    'origem', (select coalesce(jsonb_agg(jsonb_build_object('origem', o, 'n', n, 'do_chat', chat) order by n desc), '[]'::jsonb)
        from (select origem as o, count(*) as n, count(*) filter (where conversa_id is not null) as chat
                from public.klingo_conferencia where marcado_em >= v_hoje - v_dias group by origem) z),
    'pedidos_chat', (select coalesce(jsonb_agg(jsonb_build_object('situacao', s, 'n', n) order by n desc), '[]'::jsonb)
        from (select status as s, count(*) as n from public.pre_agendamentos where criado_em >= v_de group by status) z),
    'fila_chegada', (select jsonb_build_object('n', count(*), 'atendidos', count(*) filter (where chamado_em is not null),
            'espera_mediana_min', round((percentile_cont(0.5) within group (order by extract(epoch from (chamado_em - chegou_em)) / 60))::numeric, 1))
        from public.fila_chegada where chegou_em >= v_de and chamado_em is not null)
  ) into v_out;
  return v_out;
end;
$function$;

