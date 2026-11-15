-- public.app_porta()
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_porta()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'ativo', public.app_modo(),
    'obrigatorio', public.app_modo() and coalesce((select valor from public.config where chave = 'app_pin_obrigatorio'), 'nao') = 'sim',
    'local', public.app_modo() and coalesce((select valor from public.config where chave = 'app_local_ativo'), 'nao') = 'sim') $function$;

