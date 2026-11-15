-- public.app_pedido_apagar(p_token text, p_conversa uuid)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_pedido_apagar(p_token text, p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; c public.conversas; ac public.app_conversa%rowtype; v_p jsonb; v_cancelou boolean := false;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into ac from public.app_conversa where paciente_id = s.o_pac and conversa_id = p_conversa;
  if not found then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Não encontrei este pedido neste cadastro.'); end if;
  select * into c from public.conversas where id = p_conversa;
  if c.id is null then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Esta conversa não está mais disponível.'); end if;

  if c.status <> 'encerrada' then
    select e into v_p from jsonb_array_elements(public.app_pedido_dados(s.o_pac, p_conversa)) e limit 1;
    if v_p is not null and (v_p ->> 'pode_apagar')::boolean is not true then
      return jsonb_build_object('ok', false, 'erro', 'ativo', 'mensagem', 'Este pedido tem exame marcado. Cancele o exame primeiro (toque no pedido e escolha Cancelar); depois dá para apagar.');
    end if;
    update public.pre_agendamentos set status = 'cancelado', conferencia_status = null, conferencia_detalhe = null, atualizado_em = now()
     where conversa_id = c.id and status in ('rascunho', 'pronto');
    update public.pre_agendamento_itens set ativo = false where conversa_id = c.id and ativo;
    insert into public.mensagens (conversa_id, autor, texto) values (c.id, 'sistema', 'O paciente cancelou este pedido pelo "Acompanhe seus pedidos".');
    update public.conversas set status = 'encerrada', ia_ativa = false, motivo_encerramento = 'desistiu', encerramento_origem = 'sistema' where id = c.id;
    v_cancelou := true;
  end if;

  update public.app_conversa set removido_em = now(), removido_por = case when v_cancelou then 'cancelou' else 'paciente' end
   where paciente_id = s.o_pac and conversa_id = p_conversa;
  return jsonb_build_object('ok', true, 'cancelado', v_cancelou);
end $function$;

