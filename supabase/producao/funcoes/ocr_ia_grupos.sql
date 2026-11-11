-- public.ocr_ia_grupos(p_anexo bigint)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ocr_ia_grupos(p_anexo bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('anexo', a.id,
    'total', coalesce((a.ia_leitura ->> 'total_exames')::int, 0),
    'legibilidade', a.ia_leitura ->> 'legibilidade',
    'e_pedido', coalesce((a.ia_leitura ->> 'e_pedido_medico')::boolean, true),
    'grupos', coalesce((
      select jsonb_agg(g order by g.ord) from (
        select e.ord, jsonb_build_object('linha', left(e.v ->> 'escrito', 160), 'explicacao', left(e.v ->> 'entendido', 160), 'origem', 'ia',
                 'lado', nullif(e.v ->> 'lado', 'N'),
                 'certeza', case when cardinality(o.ops) = 0 then 'nenhum' when cardinality(o.ops) > 1 then 'duvida'
                                 when e.v ->> 'certeza' = 'baixa' then 'media' else 'alta' end,
                 'opcoes', to_jsonb(o.ops)) as g
        from jsonb_array_elements(coalesce(a.ia_leitura -> 'exames', '[]'::jsonb)) with ordinality e(v, ord)
        cross join lateral (
          select coalesce(array_agg(jsonb_build_object('rotulo', left(op.v ->> 'rotulo', 120), 'exame', ex.j) order by op.ord), '{}') as ops
          from jsonb_array_elements(coalesce(e.v -> 'opcoes', '[]'::jsonb)) with ordinality op(v, ord)
          cross join lateral (select public.ocr_exame_json(i.id, e.v ->> 'lado', e.v ->> 'escrito') as j
                              from (select (x #>> '{}')::int as id from jsonb_array_elements(coalesce(op.v -> 'ids', '[]'::jsonb)) x
                                    where jsonb_typeof(x) = 'number') i
                              join public.fluxo_exames fx on fx.id = i.id
                              order by fx.demanda desc limit 1) ex
          where ex.j is not null and op.ord <= 4) o
        where e.ord <= 12) g), '[]'::jsonb))
  from public.conversa_anexo a where a.id = p_anexo
$function$;

