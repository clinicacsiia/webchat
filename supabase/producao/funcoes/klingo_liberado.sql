-- public.klingo_liberado(p_conversa uuid, p_proc integer, p_tipo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_liberado(p_conversa uuid, p_proc integer, p_tipo text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select true $function$;

