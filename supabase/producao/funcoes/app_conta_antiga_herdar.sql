-- public.app_conta_antiga_herdar(p_pin text, p_telefone text, p_nome text, p_nascimento text, p_aparelho text)
-- Pode executar: authenticated
CREATE OR REPLACE FUNCTION public.app_conta_antiga_herdar(p_pin text, p_telefone text DEFAULT NULL::text, p_nome text DEFAULT NULL::text, p_nascimento text DEFAULT NULL::text, p_aparelho text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ select public.app_conta_antiga_migrar(p_pin, p_telefone, p_nome, p_nascimento, null, p_aparelho) $function$;

