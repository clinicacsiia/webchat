-- public.chat_arquivo_equipe(p_conversa uuid, p_token text, p_id bigint)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_arquivo_equipe(p_conversa uuid, p_token text, p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record;
begin
  perform public.chat_valida(p_conversa, p_token);
  if not exists (select 1 from public.mensagens m where m.conversa_id = p_conversa and (m.opcoes ->> 'tipo') = 'arquivo' and (m.opcoes ->> 'id') = p_id::text) then return null; end if;
  select mime, dados, nome into r from public.conversa_anexo where id = p_id and conversa_id = p_conversa and tipo = 'equipe_arquivo';
  if not found then return null; end if;
  return jsonb_build_object('mime', r.mime, 'nome', r.nome, 'base64', encode(r.dados, 'base64'));
end $function$;

