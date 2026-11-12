-- public.klingo_plano_mapear_auto()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_plano_mapear_auto()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_a integer := 0; v_n integer := 0;
begin
  with conv as (
    select convenio_id, convenio_norm, (array_agg(plano_id order by plano_id) filter (where padrao))[1] as padrao_id, count(*) as n, min(plano_id) as unico
      from public.klingo_convenio group by convenio_id, convenio_norm),
  ops as (select distinct operadora from public.catalogo_plano where coalesce(ativo, true) and nullif(btrim(operadora), '') is not null)
  insert into public.klingo_plano_map (operadora, convenio_id, plano_id, origem)
  select o.operadora, c.convenio_id, case when c.padrao_id is not null then c.padrao_id when c.n = 1 then c.unico end, 'auto'
    from ops o join conv c on c.convenio_norm = public.norm_nome(o.operadora)
  on conflict (operadora) do update set convenio_id = excluded.convenio_id, plano_id = excluded.plano_id, origem = 'auto', atualizado_em = now()
    where public.klingo_plano_map.origem in ('auto', 'nao_atende');
  get diagnostics v_a = row_count;
  insert into public.klingo_plano_map (operadora, origem)
  select o.operadora, 'nao_atende' from (select distinct operadora from public.catalogo_plano where coalesce(ativo, true) and nullif(btrim(operadora), '') is not null) o
   where not exists (select 1 from public.klingo_plano_map m where m.operadora = o.operadora)
  on conflict (operadora) do nothing;
  get diagnostics v_n = row_count;
  return jsonb_build_object('traduzidos', v_a, 'sem_correspondencia_novos', v_n);
end $function$;

