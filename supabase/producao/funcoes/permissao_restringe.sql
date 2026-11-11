-- public.permissao_restringe()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.permissao_restringe()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select valor = 'ligado' from public.config where chave = 'permissao_modo'), false)
$function$;

