-- public.chat_pedido_escolha(p_conversa uuid, p_token text, p_anexo bigint, p_escolha jsonb)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_pedido_escolha(p_conversa uuid, p_token text, p_anexo bigint, p_escolha jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.chat_valida(p_conversa, p_token);
  if jsonb_typeof(p_escolha) <> 'array' or jsonb_array_length(p_escolha) > 20 or length(p_escolha::text) > 20000 then
    raise exception 'Escolha inválida.' using errcode = '22023';
  end if;
  update public.conversa_anexo set escolha = p_escolha, escolha_em = now() where id = p_anexo and conversa_id = p_conversa;
end $function$;

