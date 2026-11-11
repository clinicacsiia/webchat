-- public.fone_chave(t text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.fone_chave(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case when d = '' then null
              when length(d) = 11 and substr(d, 3, 1) = '9' then substr(d, 1, 2) || substr(d, 4)
              else right(d, 10) end
  from (select case when length(regexp_replace(coalesce(t, ''), '\D', '', 'g')) >= 12 and left(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 2) = '55'
                    then substr(regexp_replace(coalesce(t, ''), '\D', '', 'g'), 3) else regexp_replace(coalesce(t, ''), '\D', '', 'g') end) q(d)
$function$;

