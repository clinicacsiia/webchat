-- public.catalogo_cardapio_operadoras()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.catalogo_cardapio_operadoras()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then
    raise exception 'Somente administrador.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(o order by o) from (select distinct case when fonte = 'particular' then 'PARTICULAR' else operadora end as o
                    from public.catalogo_preco where status = 'ativo' and operadora is not null) q), '[]'::jsonb);
end $function$;

