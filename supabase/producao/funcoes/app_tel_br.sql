-- public.app_tel_br(t text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_tel_br(t text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case when d ~ '^[1-9]{2}9[0-9]{8}$' then d when d ~ '^55[1-9]{2}9[0-9]{8}$' then substr(d, 3) end
  from (select regexp_replace(coalesce(t, ''), '\D', '', 'g') as d) x $function$;

