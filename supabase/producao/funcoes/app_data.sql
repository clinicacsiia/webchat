-- public.app_data(t text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_data(t text)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
begin
  if t is null or t !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  return t::date;
exception when others then return null;
end $function$;

