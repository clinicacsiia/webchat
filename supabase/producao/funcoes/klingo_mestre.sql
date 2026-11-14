-- public.klingo_mestre()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_mestre()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select 'sim'::text $function$;

