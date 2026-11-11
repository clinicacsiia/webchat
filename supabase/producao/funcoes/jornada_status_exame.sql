-- public.jornada_status_exame(p_status text, p_atendido text, p_motivo text, p_confirm text, p_para date, p_hoje date)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.jornada_status_exame(p_status text, p_atendido text, p_motivo text, p_confirm text, p_para date, p_hoje date)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when upper(trim(coalesce(p_atendido, ''))) = 'S' then 'atendido'
    when coalesce(p_status, '') ilike 'cancel%' then case when coalesce(p_motivo, '') ilike 'remarcad%' then 'remarcado' else 'cancelado' end
    when p_para < p_hoje then 'faltou'
    when coalesce(p_confirm, '') ilike 'confirmad%' then 'confirmado'
    else 'agendado'
  end;
$function$;

