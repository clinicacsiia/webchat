-- public.chat_push_silenciar(p_conversa uuid, p_token text, p_silenciar boolean)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_push_silenciar(p_conversa uuid, p_token text, p_silenciar boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  update public.conversas set push_silenciado_em = case when coalesce(p_silenciar, false) then coalesce(push_silenciado_em, now()) end where id = p_conversa;
  return coalesce(p_silenciar, false);
end $function$;

