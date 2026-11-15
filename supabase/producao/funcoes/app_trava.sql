-- public.app_trava(p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_trava(p_id uuid)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select ceil(extract(epoch from (a.pin_bloqueado_ate - now())))::int from public.app_paciente a where a.id = p_id and a.pin_bloqueado_ate > now()), 0) $function$;

