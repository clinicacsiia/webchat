-- public.fila_dia(p timestamp with time zone)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.fila_dia(p timestamp with time zone)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select (p at time zone 'America/Sao_Paulo')::date
$function$;

