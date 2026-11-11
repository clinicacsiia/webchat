-- public.fila_b64url(p bytea)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_b64url(p bytea)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select translate(replace(encode(p, 'base64'), E'\n', ''), '+/=', '-_')
$function$;

