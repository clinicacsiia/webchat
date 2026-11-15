-- public.app_filho_salvar(p_token text, p_nome text, p_nascimento text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_filho_salvar(p_token text, p_nome text, p_nascimento text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ select public.app_filho_adicionar(p_token, p_nome, p_nascimento, false) $function$;

