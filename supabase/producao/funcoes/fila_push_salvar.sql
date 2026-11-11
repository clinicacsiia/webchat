-- public.fila_push_salvar(p_endpoint text, p_p256dh text, p_auth text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_push_salvar(p_endpoint text, p_p256dh text, p_auth text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_uid uuid := (select auth.uid());
begin
  if v_uid is null then raise exception 'Entre na sua conta.' using errcode = '28000'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'Inscrição de notificação inválida.' using errcode = '22023';
  end if;
  insert into public.push_inscricao (conta_id, endpoint, p256dh, auth) values (v_uid, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set conta_id = excluded.conta_id, p256dh = excluded.p256dh, auth = excluded.auth;
end $function$;

