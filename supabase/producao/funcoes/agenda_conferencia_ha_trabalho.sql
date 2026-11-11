-- public.agenda_conferencia_ha_trabalho(p_lento boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_conferencia_ha_trabalho(p_lento boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_array_length(public.agenda_conferencia_alvos(p_lento, true) -> 'alvos') > 0
$function$;

