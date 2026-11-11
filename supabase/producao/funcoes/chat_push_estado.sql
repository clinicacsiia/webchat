-- public.chat_push_estado(p_conversa uuid, p_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_push_estado(p_conversa uuid, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  return jsonb_build_object('inscrito', exists (select 1 from public.chat_push_inscricao where conversa_id = p_conversa),
                            'silenciado', (select push_silenciado_em is not null from public.conversas where id = p_conversa));
end $function$;

