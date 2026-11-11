-- public.equipe_pedido_reforcar()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.equipe_pedido_reforcar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.agentes set pedido_em = now() where id = (select auth.uid()) and not ativo;
    return jsonb_build_object('ok', true, 'renovado', found);
    end $function$;

