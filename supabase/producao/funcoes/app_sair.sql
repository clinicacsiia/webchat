-- public.app_sair(p_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_sair(p_token text)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with apagado as (delete from public.app_aparelho where token_hash = encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex') returning 1)
  select jsonb_build_object('ok', true) $function$;

