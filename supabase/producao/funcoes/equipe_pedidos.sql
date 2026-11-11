-- public.equipe_pedidos()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.equipe_pedidos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
    begin
      if coalesce((select public.papel_atual()), '') <> 'admin' then return '[]'::jsonb; end if;
        return coalesce((
            select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome, 'email', a.email, 'papel', a.papel, 'criado_em', a.criado_em, 'pedido_em', a.pedido_em) order by coalesce(a.pedido_em, a.criado_em) desc)
                  from public.agentes a join auth.users u on u.id = a.id
                       where not a.ativo and u.email_confirmed_at is not null), '[]'::jsonb);
                       end $function$;

