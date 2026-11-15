-- public.app_cpf_mascara(p text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_cpf_mascara(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case when p ~ '^[0-9]{11}$' then '***.***.***-' || right(p, 2) end $function$;

