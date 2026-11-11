-- public.jornada_admin()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select public.papel_atual()) = 'admin', false);
$function$;

