-- public.norm_chave(t text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.norm_chave(t text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select nullif(btrim(regexp_replace(regexp_replace(upper(extensions.unaccent(coalesce(t, ''))), '[^A-Z0-9 ]', ' ', 'g'), '\s+', ' ', 'g')), '')
$function$;

