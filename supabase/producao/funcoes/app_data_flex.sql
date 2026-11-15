-- public.app_data_flex(t text)
-- Pode executar: ninguém pela API (só o dono/gatilhos/rotinas)
CREATE OR REPLACE FUNCTION public.app_data_flex(t text)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO ''
AS $function$
begin
  if t ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' then return public.app_data(substr(t, 7, 4) || '-' || substr(t, 4, 2) || '-' || substr(t, 1, 2)); end if;
  return public.app_data(t);
end $function$;

