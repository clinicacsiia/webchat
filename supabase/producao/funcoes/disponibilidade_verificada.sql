-- public.disponibilidade_verificada(p_pedido uuid, p_resultado text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_verificada(p_pedido uuid, p_resultado text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ant text;
begin
  select ultima_verificacao_resultado into v_ant from public.disponibilidade_pedido where id = p_pedido;
  update public.disponibilidade_pedido set ultima_verificacao_em = now(), ultima_verificacao_resultado = left(p_resultado, 40) where id = p_pedido;
  if v_ant is distinct from left(p_resultado, 40) then perform public.disponibilidade_evento_gravar(p_pedido, 'verificada', 'sistema', jsonb_build_object('resultado', left(p_resultado, 40))); end if;
end $function$;

