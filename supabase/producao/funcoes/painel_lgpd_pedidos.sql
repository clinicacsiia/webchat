-- public.painel_lgpd_pedidos()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_lgpd_pedidos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só o administrador vê os pedidos de eliminação.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'criado_em', p.criado_em, 'por', (select a.nome from public.agentes a where a.id = p.por), 'resumo', p.resumo) order by p.criado_em desc)
                     from (select * from public.lgpd_pedido order by criado_em desc limit 200) p), '[]'::jsonb);
end
$function$;

