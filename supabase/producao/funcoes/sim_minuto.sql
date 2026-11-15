-- public.sim_minuto(p_quando timestamptz)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.sim_minuto(p_quando timestamptz)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
 select (extract(hour from p_quando at time zone 'America/Sao_Paulo') * 60 + extract(minute from p_quando at time zone 'America/Sao_Paulo'))::int 
$function$;

