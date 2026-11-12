-- public.klingo_medida_soma(p_tipo text, p_dias integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_medida_soma(p_tipo text, p_dias integer)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(sum(n), 0)::bigint from public.klingo_medida where tipo = p_tipo and dia > (now() at time zone 'America/Bahia')::date - greatest(p_dias, 1)
$function$;

