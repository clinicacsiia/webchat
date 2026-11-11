-- public.chat_push_remover(p_conversa uuid, p_token text, p_endpoint text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_push_remover(p_conversa uuid, p_token text, p_endpoint text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  delete from public.chat_push_inscricao i using public.conversa_segredo s
   where i.endpoint = p_endpoint and i.conversa_id = p_conversa and s.conversa_id = p_conversa and s.token = p_token
$function$;

