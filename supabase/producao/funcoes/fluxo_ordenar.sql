-- public.fluxo_ordenar(p_passo text, p_itens jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_ordenar(p_passo text, p_itens jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(x.v order by coalesce(o.peso, 0) desc, x.ord), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) with ordinality x(v, ord)
    left join public.fluxo_opcao_ordem o on o.passo = p_passo and lower(o.valor) = lower(coalesce(x.v ->> 'valor', ''))
$function$;

