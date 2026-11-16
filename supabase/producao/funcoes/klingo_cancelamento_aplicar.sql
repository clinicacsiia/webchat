-- public.klingo_cancelamento_aplicar(p_op uuid, p_estado text, p_cod text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_cancelamento_aplicar(p_op uuid, p_estado text, p_cod text)
 RETURNS jsonb
 LANGUAGE plpgsql
SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare op public.klingo_operacao; ctx jsonb; v_vou text; v_res text; v_pos text; v_quem text;
begin
  select * into op from public.klingo_operacao where id = p_op;
  v_vou := op.detalhe ->> 'voucher';
  -- Pedido da equipe (painel): só atualiza as marcações e deixa uma nota para a equipe. Nada de mensagem, transferência ou passo do chat para o paciente.
  if op.detalhe ->> 'por' = 'painel' then
    select a.nome into v_quem from public.agentes a where a.id::text = op.detalhe ->> 'agente';
    if p_estado = 'sucesso' then
      update public.klingo_marcacao set situacao = 'cancelada', consultado_em = now() where voucher = v_vou and situacao in ('ativa', 'nao_listada');
      update public.pre_agendamentos set status = 'cancelado', conferencia_status = 'sumiu', conferencia_em = now(), atualizado_em = now() where klingo_marcacoes @> array[v_vou] and status = 'agendado';
      perform public.fluxo_nota(op.conversa_id, 'Marcação ' || coalesce(v_vou, '?') || ' cancelada no Klingo pelo painel' || coalesce(' (' || v_quem || ')', '') || '.');
      return jsonb_build_object('ok', true, 'estado', 'sucesso');
    end if;
    perform public.fluxo_nota(op.conversa_id, 'Cancelamento pelo painel NÃO concluído (' || coalesce(p_cod, 'falha') || '). A marcação ' || coalesce(v_vou, '?') || ' pode continuar ATIVA no Klingo: conferir'
      || case when p_estado = 'incerto' then ' ANTES de qualquer nova tentativa.' else '.' end);
    return jsonb_build_object('ok', true, 'estado', p_estado);
  end if;
  ctx := public.fluxo_ctx(op.conversa_id);
  select public.klingo_marc_resumo(op.conversa_id, v_vou) into v_res;
  select passo into v_pos from public.conversa_fluxo where conversa_id = op.conversa_id;
  if p_estado = 'sucesso' then
    update public.klingo_marcacao set situacao = 'cancelada', consultado_em = now() where voucher = v_vou and situacao in ('ativa', 'nao_listada');
    update public.pre_agendamentos set status = 'cancelado', conferencia_status = 'sumiu', conferencia_em = now(), atualizado_em = now() where klingo_marcacoes @> array[v_vou] and status = 'agendado';
    perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'pos', 'marc_voucher', null, 'marc_acao', null));
    perform public.fluxo_perguntar(op.conversa_id, 'marc_pos', public.fluxo_t('marc_cancelado', ctx) || coalesce(E'\n\n' || v_res, ''));
    return jsonb_build_object('ok', true, 'estado', 'sucesso');
  end if;
  perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_acao', null));
  perform public.fluxo_nota(op.conversa_id, 'Cancelamento automático NÃO concluído (' || coalesce(p_cod, 'falha') || '). A marcação ' || coalesce(v_vou, '?') || ' pode continuar ATIVA no Klingo: conferir' || case when p_estado = 'incerto' then ' ANTES de qualquer nova tentativa.' else '.' end);
  perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('cancelar_equipe', ctx));
  perform public.fluxo_transferir(op.conversa_id, 'Paciente pediu para cancelar a marcação ' || coalesce(v_vou, '?') || ' e o cancelamento automático não concluiu (' || coalesce(p_cod, 'falha') || ').', case when p_estado = 'incerto' then 'media' else 'baixa' end, false);
  return jsonb_build_object('ok', true, 'estado', p_estado);
end $function$;

