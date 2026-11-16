-- public.particular_plano_id()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.particular_plano_id()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select m.plano_id::int from public.klingo_plano_map m where public.norm_chave(m.operadora) = 'PARTICULAR' order by m.plano_id limit 1), 1)
$function$;

