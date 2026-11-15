-- public.app_norm(t text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_norm(t text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select lower(extensions.unaccent(btrim(regexp_replace(coalesce(t, ''), '\s+', ' ', 'g')))) $function$;

