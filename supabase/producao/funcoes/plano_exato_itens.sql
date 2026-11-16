-- public.plano_exato_itens(p_convenio integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.plano_exato_itens(p_convenio integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with c as (select k.plano_id, btrim(k.plano) as plano, k.convenio_norm from public.klingo_convenio k
              where k.convenio_id = p_convenio and nullif(btrim(k.plano), '') is not null),
  ei as (select exists (select 1 from c where public.norm_nome(c.plano) like c.convenio_norm || ' EMPRESA%')
             and exists (select 1 from c where public.norm_nome(c.plano) like c.convenio_norm || ' INDIVIDUAL%') as tem),
  n as (select c.*, count(*) over (partition by lower(c.plano)) as qtd, row_number() over (partition by lower(c.plano) order by c.plano_id) as ordem from c)
  select coalesce(jsonb_agg(jsonb_build_object('valor', n.plano_id::text,
           'rotulo', left(n.plano || case when n.qtd = 1 then ''
                                          when ei.tem and n.qtd = 2 then case n.ordem when 1 then ' (Empresarial)' else ' (Individual)' end
                                          else ' (opção ' || n.ordem || ')' end, 120)) order by n.plano, n.plano_id), '[]'::jsonb)
    from n cross join ei
$function$;

