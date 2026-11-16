-- public.app_codigo_exigido()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_codigo_exigido()
 RETURNS boolean
 LANGUAGE sql STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.app_modo() and coalesce((select valor from public.config where chave = 'app_codigo_email'), 'nao') = 'sim' $function$;

