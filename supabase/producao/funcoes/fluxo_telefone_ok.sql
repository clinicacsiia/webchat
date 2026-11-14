-- public.fluxo_telefone_ok(p text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_telefone_ok(p text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  with t as (select case when char_length(regexp_replace(coalesce(p, ''), '\D', '', 'g')) in (12, 13) and left(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 2) = '55'
                         then substr(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 3) else regexp_replace(coalesce(p, ''), '\D', '', 'g') end d)
  select char_length(d) in (10, 11) and d ~ '^[1-9][1-9]' and (char_length(d) = 10 or substr(d, 3, 1) = '9') and substr(d, 3, 1) <> '0' and d !~ '^(\d)\1+$' from t
$function$;

