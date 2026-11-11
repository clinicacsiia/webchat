-- public.cpf_digitos(t text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.cpf_digitos(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select nullif(regexp_replace(coalesce(t, ''), '\D', '', 'g'), '')
$function$;

