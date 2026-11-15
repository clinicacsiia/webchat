-- public.app_modo()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_modo()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select valor from public.config where chave = 'app_acesso_modo'), 'nao') = 'sim' $function$;

