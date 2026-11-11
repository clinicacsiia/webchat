-- public.jornada_klingo_expediente(p_agora timestamp with time zone)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_klingo_expediente(p_agora timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select extract(isodow from (p_agora at time zone 'America/Sao_Paulo')) between 1 and 6
     and (p_agora at time zone 'America/Sao_Paulo')::time >= time '06:30'
     and (p_agora at time zone 'America/Sao_Paulo')::time <  time '18:30';
$function$;

