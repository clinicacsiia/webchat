-- public.fone_digitos(t text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fone_digitos(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case when length(d) in (10, 11) then d end
  from (select case when length(regexp_replace(coalesce(t, ''), '\D', '', 'g')) in (12, 13) and left(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 2) = '55'
                    then substr(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 3) else regexp_replace(coalesce(t, ''), '\D', '', 'g') end) q(d)
$function$;

