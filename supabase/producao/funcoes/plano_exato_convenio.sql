-- public.plano_exato_convenio(p_operadora text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.plano_exato_convenio(p_operadora text)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.convenio_id from public.klingo_plano_map m
   where lower(btrim(m.operadora)) = lower(btrim(coalesce(p_operadora, '')))
     and m.origem <> 'nao_atende' and m.plano_id is null and m.convenio_id is not null
     and coalesce(public.klingo_cfg('plano_exato_modo', 'sim'), 'sim') = 'sim'
     and (select count(*) from public.klingo_convenio k where k.convenio_id = m.convenio_id) > 1
   limit 1
$function$;

