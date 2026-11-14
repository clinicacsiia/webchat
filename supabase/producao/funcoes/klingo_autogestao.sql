-- public.klingo_autogestao()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_autogestao()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select jsonb_build_object('ligada', false, 'motivo', 'removida') $function$;

