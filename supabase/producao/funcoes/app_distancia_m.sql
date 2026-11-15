-- public.app_distancia_m(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_distancia_m(p_lat1 numeric, p_lng1 numeric, p_lat2 numeric, p_lng2 numeric)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select round(2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians((p_lat2 - p_lat1)::float8) / 2), 2) +
    cos(radians(p_lat1::float8)) * cos(radians(p_lat2::float8)) * power(sin(radians((p_lng2 - p_lng1)::float8) / 2), 2)))))::integer $function$;

