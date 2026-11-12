-- public.klingo_cota_429()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_cota_429()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.klingo_cota set fichas = 0, reposto_em = clock_timestamp(), pausado_ate = clock_timestamp() + interval '60 seconds', ultimo_429_em = now() where id;
  perform public.klingo_medir('api_429');
end $function$;

