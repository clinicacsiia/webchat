-- public.chat_push_salvar(p_conversa uuid, p_token text, p_endpoint text, p_p256dh text, p_auth text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_push_salvar(p_conversa uuid, p_token text, p_endpoint text, p_p256dh text, p_auth text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if not exists (select 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token) then
    raise exception 'Conversa não encontrada.' using errcode = '28000';
  end if;
  if coalesce(p_endpoint, '') !~ '^https://' or char_length(p_endpoint) > 1000 or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Inscrição de notificação inválida.' using errcode = '22023';
  end if;
  insert into public.chat_push_inscricao (conversa_id, endpoint, p256dh, auth) values (p_conversa, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set conversa_id = excluded.conversa_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $function$;

