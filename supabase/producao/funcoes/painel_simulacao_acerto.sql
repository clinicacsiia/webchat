-- public.painel_simulacao_acerto(p_dias integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_simulacao_acerto(p_dias integer DEFAULT 365)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tz text := 'America/Sao_Paulo';
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_dias integer := greatest(7, least(coalesce(p_dias, 365), 400));
  v_de timestamptz; v_ate timestamptz; v_out jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem a simulação.' using errcode = '42501';
  end if;
  v_de := (v_hoje - v_dias)::timestamp at time zone v_tz;
  v_ate := v_hoje::timestamp at time zone v_tz;
  select jsonb_build_object(
    'de', v_hoje - v_dias, 'ate', v_hoje - 1, 'primeiro_dia', min(d), 'gerado_em', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'dias', coalesce(jsonb_agg(jsonb_build_object(
        'dia', d, 'atendidos', att, 'faltaram', fal, 'cancelados', can, 'remarcados', rem,
        'conf', jsonb_build_object(
          'confirmado',  jsonb_build_object('n', c_n, 'f', c_f),
          'a_confirmar', jsonb_build_object('n', a_n, 'f', a_f),
          'sem_resposta', jsonb_build_object('n', s_n, 'f', s_f),
          'outro',       jsonb_build_object('n', o_n, 'f', o_f))) order by d), '[]'::jsonb))
    into v_out
    from (select (e.agendado_para at time zone v_tz)::date as d,
                 count(*) filter (where e.status = 'atendido') as att, count(*) filter (where e.status = 'faltou') as fal,
                 count(*) filter (where e.status = 'cancelado') as can, count(*) filter (where e.status = 'remarcado') as rem,
                 count(*) filter (where e.status in ('atendido', 'faltou') and e.confirm_status = 'Confirmado') as c_n,
                 count(*) filter (where e.status = 'faltou' and e.confirm_status = 'Confirmado') as c_f,
                 count(*) filter (where e.status in ('atendido', 'faltou') and e.confirm_status = 'A Confirmar') as a_n,
                 count(*) filter (where e.status = 'faltou' and e.confirm_status = 'A Confirmar') as a_f,
                 count(*) filter (where e.status in ('atendido', 'faltou') and e.confirm_status = 'Sem Resposta') as s_n,
                 count(*) filter (where e.status = 'faltou' and e.confirm_status = 'Sem Resposta') as s_f,
                 count(*) filter (where e.status in ('atendido', 'faltou') and (e.confirm_status is null or e.confirm_status not in ('Confirmado', 'A Confirmar', 'Sem Resposta'))) as o_n,
                 count(*) filter (where e.status = 'faltou' and (e.confirm_status is null or e.confirm_status not in ('Confirmado', 'A Confirmar', 'Sem Resposta'))) as o_f
            from public.jornada_exame e
           where e.marcacao_id like 'm%' and e.agendado_para >= v_de and e.agendado_para < v_ate
             and public.sim_unidade(e.unidade) is not null and public.sim_modalidade(e.procedimento) is not null
           group by 1) z;
  return v_out;
end;
$function$;

