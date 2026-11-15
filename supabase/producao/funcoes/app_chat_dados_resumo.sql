-- public.app_chat_dados_resumo(p_token text, p_conversa uuid, p_conv_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_chat_dados_resumo(p_token text, p_conversa uuid, p_conv_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; r record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  begin perform public.chat_valida(p_conversa, p_conv_token);
  exception when others then return jsonb_build_object('ok', false, 'erro', 'conversa'); end;
  select * into r from public.app_chat_pessoa(s.o_pac, p_conversa);
  if r.o_erro is not null then return jsonb_build_object('ok', false, 'erro', r.o_erro); end if;
  return jsonb_build_object('ok', true, 'tem', r.o_cpf is not null and r.o_nasc is not null, 'cpf_mascara', public.app_cpf_mascara(r.o_cpf),
    'nascimento', r.o_nasc, 'primeiro_nome', split_part(r.o_nome, ' ', 1), 'eu', r.o_eu);
end $function$;

