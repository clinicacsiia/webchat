-- public.app_acesso_limpar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_acesso_limpar()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_n integer;
begin
  with apagados as (delete from public.app_acesso_log where em < now() - interval '180 days' returning 1)
  select count(*)::integer into v_n from apagados;
  return v_n;
end $function$;

