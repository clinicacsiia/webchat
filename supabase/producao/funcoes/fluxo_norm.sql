-- public.fluxo_norm(t text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.fluxo_norm(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select btrim(regexp_replace(lower(extensions.unaccent(coalesce(t, ''))), '\s+', ' ', 'g'))
$function$;

