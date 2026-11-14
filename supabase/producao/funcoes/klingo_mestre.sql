-- public.klingo_mestre()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_mestre()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select case when m in ('teste', 'sim', 'legado') then m else 'nao' end from (select coalesce((select valor from public.config where chave = 'klingo_auto'), 'nao') as m) x $function$;

