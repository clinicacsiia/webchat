-- public.org_nivel()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.org_nivel()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.org_nivel_de((select auth.uid()), (select public.papel_atual()))
$function$;

