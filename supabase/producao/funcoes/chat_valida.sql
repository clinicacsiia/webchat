-- public.chat_valida(p_conversa uuid, p_token text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.chat_valida(p_conversa uuid, p_token text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
end $function$;

