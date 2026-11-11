-- public.norm_nome(t text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.norm_nome(t text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select nullif(btrim(regexp_replace(regexp_replace(upper(extensions.unaccent(coalesce(t, ''))), '[^A-Z ]', ' ', 'g'), '\s+', ' ', 'g')), '')
$function$;

