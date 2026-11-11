-- public.pessoa_nasc_parecida(a text, b text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_nasc_parecida(a text, b text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select a is not null and b is not null and a <> b and length(a) = 10 and length(b) = 10 and (
    (select count(*) from generate_series(1, 10) i where substr(a, i, 1) <> substr(b, i, 1)) = 1
    or (substr(a, 1, 4) = substr(b, 1, 4) and substr(a, 6, 2) = substr(b, 9, 2) and substr(a, 9, 2) = substr(b, 6, 2)))
$function$;

