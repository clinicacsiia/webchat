-- public.origem_limpa(p_origem text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.origem_limpa(p_origem text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select nullif(left((regexp_match(btrim(coalesce(p_origem, '')), '^[A-Za-z0-9_-]+'))[1], 40), '')
$function$;

