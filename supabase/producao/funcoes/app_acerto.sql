-- public.app_acerto(p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_acerto(p_id uuid)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.app_paciente set pin_falhas = 0, pin_bloqueado_ate = null where id = p_id and (pin_falhas <> 0 or pin_bloqueado_ate is not null) $function$;

