-- public.data_ou_nula(t text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.data_ou_nula(t text)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
begin
  if t is null or t !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return t::date;
exception when others then return null;
end $function$;

