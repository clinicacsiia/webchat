-- public.chat_previsao_aceitar(p_conversa uuid, p_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_previsao_aceitar(p_conversa uuid, p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  update public.conversas set previsao_aceita_em = coalesce(previsao_aceita_em, now()) where id = p_conversa;
  return true;
end $function$;

