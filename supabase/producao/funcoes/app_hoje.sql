-- public.app_hoje()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_hoje()
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$ select (now() at time zone 'America/Sao_Paulo')::date $function$;

