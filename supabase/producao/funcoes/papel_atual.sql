-- public.papel_atual()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.papel_atual()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select papel from public.agentes where id = (select auth.uid()) and ativo
$function$;

