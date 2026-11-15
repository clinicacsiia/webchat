-- public.app_pedido_reabrir(p_token text, p_conversa uuid)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_pedido_reabrir(p_token text, p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; c public.conversas; v_tok text;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if not exists (select 1 from public.app_conversa where paciente_id = s.o_pac and conversa_id = p_conversa) then
    return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Não encontrei este pedido neste cadastro.');
  end if;
  select * into c from public.conversas where id = p_conversa;
  select token into v_tok from public.conversa_segredo where conversa_id = p_conversa;
  if c.id is null or v_tok is null then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Esta conversa não está mais disponível.'); end if;
  if c.status = 'encerrada' then
    if c.encerramento_origem = 'paciente' then
      return jsonb_build_object('ok', false, 'erro', 'substituida', 'mensagem', 'Este pedido já continuou em uma conversa nova. Abra a conversa mais recente.');
    end if;
    if c.encerrada_em is null or c.encerrada_em < now() - interval '30 days' then
      return jsonb_build_object('ok', false, 'erro', 'prazo', 'mensagem', 'Já passou o prazo para reabrir. Abra uma conversa nova pelo chat.');
    end if;
    begin
      update public.conversas set status = 'aguardando', agente_id = null where id = c.id;
      update public.conversas set ia_ativa = false where id = c.id;
      perform public.chat_enviar(c.id, v_tok, 'Quero reabrir este pedido.');
    exception when others then
      return jsonb_build_object('ok', false, 'erro', 'reabrir', 'mensagem', 'Não foi possível reabrir agora. Tente de novo ou fale com a clínica.');
    end;
    update public.app_conversa ac set visto_em = now(),
           visto_sig = coalesce((select e ->> 'sig' from jsonb_array_elements(public.app_pedido_dados(ac.paciente_id, ac.conversa_id)) e limit 1), md5(''))
     where ac.paciente_id = s.o_pac and ac.conversa_id = c.id;
  end if;
  select * into c from public.conversas where id = p_conversa;
  return jsonb_build_object('ok', true, 'conversa', c.id, 'token', v_tok, 'aberta', c.status <> 'encerrada', 'reaberta', true, 'tipo', coalesce(c.paciente_tipo, 'proprio'),
                            'paciente_nome', c.paciente_nome, 'irmaos', coalesce(c.irmaos, '[]'::jsonb), 'irmaos_modo', c.irmaos_modo);
end $function$;

