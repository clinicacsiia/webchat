-- public.chat_medicos_disponiveis(p_conversa uuid, p_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_medicos_disponiveis(p_conversa uuid, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.chat_valida(p_conversa, p_token);
  return public.medicos_disponiveis_interno(p_conversa);
end $function$;

