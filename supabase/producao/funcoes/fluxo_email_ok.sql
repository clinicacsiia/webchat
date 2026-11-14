-- public.fluxo_email_ok(p text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_email_ok(p text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select p is not null and char_length(btrim(p)) between 6 and 200 and btrim(p) ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$' and btrim(p) !~ '\.\.'
$function$;

