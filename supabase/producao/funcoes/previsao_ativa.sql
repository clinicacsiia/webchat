-- public.previsao_ativa(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.previsao_ativa(p_conversa uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select false $function$;

