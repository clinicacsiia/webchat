-- public.app_pedido_avaliar(p_token text, p_conversa uuid, p_nota_atendimento numeric, p_nota_site numeric, p_canal text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_pedido_avaliar(p_token text, p_conversa uuid, p_nota_atendimento numeric, p_nota_site numeric, p_canal text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; v_tok text; r jsonb;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if not exists (select 1 from public.app_conversa where paciente_id = s.o_pac and conversa_id = p_conversa) then
    return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Não encontrei este pedido neste cadastro.');
  end if;
  select token into v_tok from public.conversa_segredo where conversa_id = p_conversa;
  if v_tok is null then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Esta conversa não está mais disponível.'); end if;
  begin
    r := public.chat_avaliar(p_conversa, v_tok, p_nota_atendimento, p_nota_site, p_canal);
  exception when others then
    return jsonb_build_object('ok', false, 'erro', 'avaliar', 'mensagem', case when sqlstate = '22023' then sqlerrm else 'Não foi possível enviar agora. Tente de novo.' end);
  end;
  return r;
end $function$;

