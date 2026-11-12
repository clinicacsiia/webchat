-- public.klingo_horarios_api_ativa(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_horarios_api_ativa(p_conversa uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select public.klingo_ativo(p_conversa, 'klingo_api_horarios') $function$;

