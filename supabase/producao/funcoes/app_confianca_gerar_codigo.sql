-- public.app_confianca_gerar_codigo()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_confianca_gerar_codigo()
 RETURNS text
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select lpad((('x' || substr(md5(gen_random_uuid()::text), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0') $function$;

