-- public.chat_despedida_imagem(p_conversa uuid, p_token text, p_versao bigint)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_despedida_imagem(p_conversa uuid, p_token text, p_versao bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record;
begin
  perform public.chat_valida(p_conversa, p_token);
  if not exists (select 1 from public.mensagens m where m.conversa_id = p_conversa and (m.opcoes ->> 'tipo') = 'despedida' and (m.opcoes ->> 'versao') = p_versao::text) then return null; end if;
  select mime, dados into r from public.despedida_versao where id = p_versao and dados is not null;
  if not found then return null; end if;
  return jsonb_build_object('mime', r.mime, 'base64', encode(r.dados, 'base64'));
end $function$;

