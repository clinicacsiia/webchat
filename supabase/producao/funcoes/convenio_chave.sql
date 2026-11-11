-- public.convenio_chave(t text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.convenio_chave(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select upper(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g'))
$function$;

