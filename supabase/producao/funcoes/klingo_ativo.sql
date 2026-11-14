-- public.klingo_ativo(p_conversa uuid, p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_ativo(p_conversa uuid, p_chave text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select public.klingo_modo(p_conversa, p_chave) in ('teste', 'sim') $function$;

