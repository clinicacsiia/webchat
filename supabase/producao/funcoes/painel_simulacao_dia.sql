-- public.painel_simulacao_dia(p_dia date)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_simulacao_dia(p_dia date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_dia date := coalesce(p_dia, (now() at time zone 'America/Sao_Paulo')::date);
  v_ini timestamptz; v_fim timestamptz; v_asof timestamptz; v_corte integer;
  v_visitas jsonb; v_hist jsonb; v_calib jsonb; v_meta jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem a simulação.' using errcode = '42501';
  end if;
  if v_dia < v_hoje - 120 or v_dia > v_hoje + 120 then
    raise exception 'Data fora da janela de 120 dias.' using errcode = '22023';
  end if;
  v_ini := v_dia::timestamp at time zone 'America/Sao_Paulo';
  v_fim := (v_dia + 1)::timestamp at time zone 'America/Sao_Paulo';
  v_asof := case when v_dia < v_hoje then v_fim + interval '6 hours' else now() end;
  v_corte := case when v_dia < v_hoje then 1439
                  when v_dia > v_hoje then 0
                  else (extract(hour from now() at time zone 'America/Sao_Paulo') * 60 + extract(minute from now() at time zone 'America/Sao_Paulo'))::int end;

  with ex as (
    select e.id, e.card_id, e.status, e.confirm_status, k.paciente_chave,
           public.sim_unidade(e.unidade) as u, public.sim_modalidade(e.procedimento) as t,
           (extract(hour from e.agendado_para at time zone 'America/Sao_Paulo') * 60 + extract(minute from e.agendado_para at time zone 'America/Sao_Paulo'))::int as slot
      from public.jornada_exame e join public.jornada_card k on k.id = e.card_id
     where e.marcacao_id like 'm%' and e.agendado_para >= v_ini and e.agendado_para < v_fim
  ),
  chegada as (
    select v.card_id, min(v.quando) as q
      from public.jornada_evento v
     where v.para_coluna = 'em_atendimento' and v.origem = 'klingo' and v.quando >= v_ini and v.quando < v_fim and v.quando <= v_asof
     group by v.card_id
  ),
  uteis as (select * from ex where status not in ('cancelado', 'remarcado', 'pedido') and u is not null and t is not null),
  pessoa as (select paciente_chave, dense_rank() over (order by paciente_chave)::int as n from (select distinct paciente_chave from uteis) z)
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id', x.id, 'person', p.n, 'unit', x.u, 'type', x.t, 'slot', x.slot,
           'arrive', case when c.q is not null then least((extract(hour from c.q at time zone 'America/Sao_Paulo') * 60 + extract(minute from c.q at time zone 'America/Sao_Paulo'))::int, v_corte) end,
           'absentAt', case when x.status = 'faltou' and c.q is null then least(x.slot + 15, v_corte) end,
           'confirm', case x.confirm_status when 'Confirmado' then 'confirmado' when 'A Confirmar' then 'a_confirmar' when 'Sem Resposta' then 'sem_resposta' end,
           'done', case when x.status = 'atendido' then true end
         )) order by x.slot, x.id), '[]'::jsonb),
         jsonb_build_object(
           'marcacoes_no_dia', (select count(*) from ex),
           'canceladas_ou_remarcadas', (select count(*) from ex where status in ('cancelado', 'remarcado')),
           'fora_do_modelo', (select count(*) from ex where status not in ('cancelado', 'remarcado', 'pedido') and (u is null or t is null)),
           'com_chegada_real', (select count(*) from uteis x2 join chegada c2 on c2.card_id = x2.card_id),
           'faltas_registradas', (select count(*) from uteis where status = 'faltou'),
           'sync_klingo_em', (select s.klingo_fim_em from public.jornada_sync_estado s limit 1))
    into v_visitas, v_meta
    from uteis x join pessoa p on p.paciente_chave = x.paciente_chave left join chegada c on c.card_id = x.card_id;

  -- Histórico: dias fechados (antes de hoje e antes do dia pedido), últimas 10 semanas. booked = quem tinha desfecho conhecido (atendido ou faltou).
  select coalesce(jsonb_agg(jsonb_build_object('date', h.d, 'hour', h.h, 'unit', h.u, 'type', h.t, 'booked', h.booked, 'arrivals', h.arr) order by h.d, h.h, h.u, h.t), '[]'::jsonb)
    into v_hist
    from (select (e.agendado_para at time zone 'America/Sao_Paulo')::date as d,
                 extract(hour from e.agendado_para at time zone 'America/Sao_Paulo')::int as h,
                 public.sim_unidade(e.unidade) as u, public.sim_modalidade(e.procedimento) as t,
                 count(*)::int as booked, (count(*) filter (where e.status = 'atendido'))::int as arr
            from public.jornada_exame e
           where e.marcacao_id like 'm%' and e.status in ('atendido', 'faltou')
             and e.agendado_para >= ((least(v_dia, v_hoje) - 70)::timestamp at time zone 'America/Sao_Paulo')
             and e.agendado_para < least(v_ini, (v_hoje::timestamp at time zone 'America/Sao_Paulo'))
           group by 1, 2, 3, 4) h
   where h.u is not null and h.t is not null;

  -- Calibragem medida na própria clínica (últimas 8 semanas fechadas)
  with base as (
    select e.id, e.status, e.confirm_status, public.sim_unidade(e.unidade) as u, e.card_id,
           (extract(hour from e.agendado_para at time zone 'America/Sao_Paulo') * 60 + extract(minute from e.agendado_para at time zone 'America/Sao_Paulo'))::int as slot,
           (e.agendado_para at time zone 'America/Sao_Paulo')::date as d
      from public.jornada_exame e
     where e.marcacao_id like 'm%' and e.status in ('atendido', 'faltou') and public.sim_modalidade(e.procedimento) is not null
       and e.agendado_para >= ((v_hoje - 56)::timestamp at time zone 'America/Sao_Paulo') and e.agendado_para < (v_hoje::timestamp at time zone 'America/Sao_Paulo')
  ),
  ch as (
    select b.u, b.id, (extract(hour from c.q at time zone 'America/Sao_Paulo') * 60 + extract(minute from c.q at time zone 'America/Sao_Paulo'))::int - b.slot as delta
      from base b join lateral (select min(v.quando) as q from public.jornada_evento v where v.card_id = b.card_id and v.para_coluna = 'em_atendimento' and v.origem = 'klingo') c on c.q is not null
     where b.status = 'atendido' and (c.q at time zone 'America/Sao_Paulo')::date = b.d
  )
  select jsonb_build_object(
    'faltaPorConfirmacao', (select coalesce(jsonb_object_agg(k, jsonb_build_object('taxa', round(100.0 * f / nullif(n, 0), 1), 'n', n)), '{}'::jsonb)
        from (select case confirm_status when 'Confirmado' then 'confirmado' when 'A Confirmar' then 'a_confirmar' when 'Sem Resposta' then 'sem_resposta' end as k,
                     count(*) as n, count(*) filter (where status = 'faltou') as f
                from base where confirm_status in ('Confirmado', 'A Confirmar', 'Sem Resposta') group by 1) q),
    'faltaGeral', (select round(100.0 * count(*) filter (where status = 'faltou') / nullif(count(*), 0), 1) from base),
    'chegada', (select coalesce(jsonb_object_agg(u, jsonb_build_object('n', n, 'quantis', qs)), '{}'::jsonb)
        from (select u, count(*) as n,
                     percentile_cont(array[0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]) within group (order by greatest(-90, least(90, delta))) as qs
                from ch where u is not null group by u having count(*) >= 20) z)
  ) into v_calib;

  return jsonb_build_object('date', v_dia, 'asOf', to_char(v_asof at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                            'visits', v_visitas, 'history', v_hist, 'capacity', '{}'::jsonb, 'outage', null,
                            'calibragem', v_calib, 'meta', v_meta);
end;
$function$;

