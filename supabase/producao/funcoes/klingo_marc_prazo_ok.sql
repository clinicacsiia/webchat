-- public.klingo_marc_prazo_ok(p_data date, p_hora text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_marc_prazo_ok(p_data date, p_hora text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select p_data is not null and ((p_data + coalesce(nullif(p_hora, ''), '00:00')::time) - (now() at time zone 'America/Bahia')) >= make_interval(hours => coalesce(nullif(public.klingo_cfg('klingo_pos_prazo_horas', '24'), '')::integer, 24)) $function$;

