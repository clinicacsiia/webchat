-- public.app_idade(d date)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_idade(d date)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$ select extract(year from age(public.app_hoje(), d))::int $function$;

