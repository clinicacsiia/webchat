-- public.chat_medico_limpar(p_conversa uuid, p_token text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_medico_limpar(p_conversa uuid, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.chat_valida(p_conversa, p_token);
  update public.conversas set medico_preferido = null where id = p_conversa;
  return jsonb_build_object('ok', true);
end $function$;

