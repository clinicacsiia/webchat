-- public.consulta_medicos(p_procedimento_id integer)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.consulta_medicos(p_procedimento_id integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(x.m order by x.m), '[]'::jsonb)
  from (select distinct m
        from public.unidade_config uc
        cross join lateral public.consultas_da_unidade(uc.catalogo) cu
        cross join lateral unnest(cu.medicos) as m
        where cu.id = p_procedimento_id and public.unidade_marca_auto(uc.catalogo)) x
$function$;

