-- public.agenda_conferencia_liberar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_conferencia_liberar()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ update public.agenda_ocupacao_meta set conferindo_ate = null where id = 1 $function$;

