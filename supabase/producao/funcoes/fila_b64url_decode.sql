-- public.fila_b64url_decode(p text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_b64url_decode(p text)
 RETURNS bytea
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select decode(translate(p, '-_', '+/') || repeat('=', (4 - length(p) % 4) % 4), 'base64')
$function$;

