-- public.jornada_pode()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_pode()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select public.papel_atual()) in ('admin', 'atendente'), false);
$function$;

