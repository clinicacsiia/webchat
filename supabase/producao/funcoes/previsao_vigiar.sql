-- public.previsao_vigiar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.previsao_vigiar()
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ select public.disponibilidade_vigiar() $function$;

