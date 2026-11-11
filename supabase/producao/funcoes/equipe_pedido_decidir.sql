-- public.equipe_pedido_decidir(p_agente uuid, p_aprovar boolean, p_papel text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.equipe_pedido_decidir(p_agente uuid, p_aprovar boolean, p_papel text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
                       declare v_ok boolean;
                       begin
                         if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Só administrador decide pedidos de acesso.' using errcode = '42501'; end if;
                           if p_papel is not null and p_papel not in ('admin','atendente','marketing') then raise exception 'Papel inválido.' using errcode = '22023'; end if;
                             select exists (select 1 from public.agentes a join auth.users u on u.id = a.id where a.id = p_agente and not a.ativo and u.email_confirmed_at is not null) into v_ok;
                               if not v_ok then raise exception 'Pedido não encontrado ou já decidido.' using errcode = 'P0002'; end if;
                                 if p_aprovar then
                                     update public.agentes set ativo = true, papel = coalesce(p_papel, papel) where id = p_agente;
                                       else
                                           delete from auth.users where id = p_agente;
                                             end if;
                                               return jsonb_build_object('ok', true, 'aprovado', p_aprovar);
                                               end $function$;

