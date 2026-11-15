-- public.app_ativo()
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_ativo()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select public.app_modo() $function$;

