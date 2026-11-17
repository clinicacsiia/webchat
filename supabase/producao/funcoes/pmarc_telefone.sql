-- public.pmarc_telefone(p_texto text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_telefone(p_texto text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when length(d) in (10, 11) then d
    when length(d) in (12, 13) and left(d, 2) = '55' then substr(d, 3)
  end
  from (select regexp_replace(coalesce(p_texto, ''), '\D', '', 'g') as d) x
$function$;

