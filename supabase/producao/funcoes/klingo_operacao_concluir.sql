-- public.klingo_operacao_concluir(p_op uuid, p_estado text, p_r jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_operacao_concluir(p_op uuid, p_estado text, p_r jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  op public.klingo_operacao; pa public.pre_agendamentos; v jsonb := coalesce(p_r -> 'voucher', '{}'::jsonb); v_est text := p_estado; ctx jsonb; v_txt text; v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  v_data date; v_cod text := left(p_r ->> 'codigo', 60); v_plano text; v_rem boolean;
begin
  if v_est not in ('sucesso', 'falha', 'incerto', 'horario_tomado') then v_est := 'falha'; end if;
  select * into op from public.klingo_operacao where id = p_op for update;
  if op.id is null then return jsonb_build_object('ok', false, 'motivo', 'inexistente'); end if;
  if op.estado in ('sucesso', 'cancelada') then return jsonb_build_object('ok', true, 'repetido', true); end if;
  select * into pa from public.pre_agendamentos where id = op.pre_agendamento_id;
  ctx := public.fluxo_ctx(op.conversa_id);
  update public.klingo_operacao set estado = v_est, voucher_id = left(v ->> 'id', 30), http_status = nullif(p_r ->> 'http_status', '')::int, caminho = left(p_r ->> 'caminho', 80), codigo = v_cod, concluido_em = now() where id = p_op;
  perform public.klingo_medir('op_' || v_est, 1, extract(milliseconds from now() - op.iniciado_em)::bigint);
  v_rem := op.tipo = 'remarcar';

  -- cancelar
  if op.tipo = 'cancelar' then
    if v_est = 'sucesso' then
      update public.pre_agendamentos set status = 'cancelado', conferencia_status = 'sumiu', atualizado_em = now() where id = pa.id;
      update public.conversa_fluxo set passo = 'cancelado', dados = dados || jsonb_build_object('cancelado_em', now()), atualizado_em = now() where conversa_id = op.conversa_id;
      perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('cancelado', ctx), jsonb_build_object('tipo', 'nova'));
      update public.conversas set status = 'encerrada', encerrada_em = now(), motivo_encerramento = 'desistiu', encerramento_origem = 'sistema' where id = op.conversa_id and status <> 'encerrada';
      return jsonb_build_object('ok', true, 'estado', 'sucesso');
    end if;
    perform public.fluxo_nota(op.conversa_id, 'Cancelamento automático NÃO concluído (' || coalesce(v_cod, 'falha') || '). O agendamento ' || coalesce(op.detalhe ->> 'voucher', '?') || ' pode continuar ativo no Klingo: conferir.');
    perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('cancelar_equipe', ctx));
    perform public.fluxo_transferir(op.conversa_id, 'Paciente pediu para cancelar o agendamento e o cancelamento automático não concluiu (' || coalesce(v_cod, 'falha') || ').', case when v_est = 'incerto' then 'media' else 'baixa' end, false);
    return jsonb_build_object('ok', true, 'estado', v_est);
  end if;

  if v_est = 'sucesso' and nullif(v ->> 'id', '') is not null then
    v_data := (v ->> 'data')::date;
    if v_rem then
      update public.pre_agendamentos set klingo_marcacoes = array[v ->> 'id'], conferencia_status = 'confirmado', conferencia_detalhe = null, conferencia_em = now(), etapa = 'pronto',
             escolha_horario = jsonb_build_array(jsonb_build_object('grupo', 1, 'data', v ->> 'data', 'hora', v ->> 'hora', 'min', 30, 'chegada', false, 'unidade', nullif(v ->> 'unidade', ''),
                               'profissional', nullif(v ->> 'profissional', ''), 'procedimento', nullif(v ->> 'procedimento', ''), 'origem', 'klingo_api', 'klingo_chave', op.detalhe ->> 'chave')), atualizado_em = now()
       where id = pa.id;
      update public.conversa_fluxo set passo = 'marcado', dados = (dados - 'remarcando') || jsonb_build_object('marcado_em', now(), 'operacao', p_op), atualizado_em = now() where conversa_id = op.conversa_id;
    else
      update public.pre_agendamentos set status = 'agendado', agendado_origem = 'chat_api', agendado_auto_em = now(), klingo_marcacoes = array[v ->> 'id'], conferencia_status = 'confirmado', conferencia_detalhe = null,
             conferencia_em = now(), conferencia_falhas = 0, confirmacao_enviada_em = coalesce(confirmacao_enviada_em, now()), etapa = 'pronto',
             escolha_horario_chat = coalesce(escolha_horario_chat, escolha_horario),
             escolha_horario = jsonb_build_array(jsonb_build_object('grupo', 1, 'data', v ->> 'data', 'hora', v ->> 'hora', 'min', 30, 'chegada', false, 'unidade', nullif(v ->> 'unidade', ''),
                               'profissional', nullif(v ->> 'profissional', ''), 'procedimento', nullif(v ->> 'procedimento', ''), 'origem', 'klingo_api', 'klingo_chave', op.detalhe ->> 'chave')),
             atualizado_em = now()
       where id = pa.id;
      update public.conversa_fluxo set passo = 'marcado', dados = dados || jsonb_build_object('marcado_em', now(), 'operacao', p_op), atualizado_em = now() where conversa_id = op.conversa_id;
    end if;
    v_txt := public.fluxo_t(case when v_rem then 'remarcado' else 'marcado' end, ctx) || E'\n\n' || coalesce(nullif(v ->> 'procedimento', ''), 'Atendimento') || E'\n'
             || v_dias[extract(dow from v_data)::int + 1] || ', ' || to_char(v_data, 'DD/MM') || ' às ' || (v ->> 'hora')
             || coalesce(E'\n' || nullif(v ->> 'unidade', ''), '') || coalesce(E'\nCom ' || nullif(v ->> 'profissional', ''), '')
             || E'\n\nChegue com 15 minutos de antecedência, com documento com foto' || case when public.norm_nome(pa.plano) = 'PARTICULAR' then '.' else ' e a carteirinha do convênio.' end
             || E' Se precisar remarcar ou cancelar, é só tocar em um dos botões abaixo.';
    perform public.fluxo_dizer(op.conversa_id, v_txt, jsonb_build_object('tipo', 'marcado', 'voucher', jsonb_build_object('id', v ->> 'id', 'data', v ->> 'data', 'hora', v ->> 'hora',
      'procedimento', v ->> 'procedimento', 'unidade', v ->> 'unidade', 'profissional', v ->> 'profissional')));
    perform public.fluxo_pos_menu(op.conversa_id);
    return jsonb_build_object('ok', true, 'estado', 'sucesso');
  end if;

  if v_est = 'horario_tomado' then
    delete from public.klingo_oferta where conversa_id = op.conversa_id and chave = op.detalhe ->> 'chave';
    update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null, atualizado_em = now() where id = pa.id and status not in ('cancelado') and (status <> 'agendado' or v_rem);
    update public.conversa_fluxo set dados = dados || '{"confirmado": false, "sem_horario": false}'::jsonb, atualizado_em = now() where conversa_id = op.conversa_id;
    perform public.fluxo_perguntar(op.conversa_id, 'horario', public.fluxo_t('marcar_ocupado', ctx));
    return jsonb_build_object('ok', true, 'estado', 'horario_tomado');
  end if;

  -- remarcação que não concluiu: a equipe assume, o agendamento anterior segue valendo
  if v_rem then
    perform public.fluxo_nota(op.conversa_id, 'Remarcação automática NÃO concluída (' || coalesce(v_cod, 'falha') || '). ' || case when v_est = 'incerto' then 'ATENÇÃO: o Klingo não confirmou; conferir na agenda se o horário novo foi marcado ANTES de repetir. ' else '' end
      || 'O agendamento anterior (voucher ' || coalesce(op.detalhe ->> 'remarcacao', '?') || ') pode continuar ativo.');
    perform public.fluxo_dizer(op.conversa_id, public.fluxo_t(case when v_est = 'incerto' then 'marcar_incerto' else 'marcar_equipe' end, ctx));
    perform public.fluxo_transferir(op.conversa_id, 'Paciente quer remarcar o agendamento e a remarcação automática não concluiu (' || coalesce(v_cod, 'falha') || ').', case when v_est = 'incerto' then 'media' else 'baixa' end, false);
    update public.conversa_fluxo set dados = dados - 'remarcando', atualizado_em = now() where conversa_id = op.conversa_id;
    return jsonb_build_object('ok', true, 'estado', v_est);
  end if;

  v_plano := coalesce(pa.plano, '');
  if v_est = 'incerto' then
    perform public.fluxo_finalizar_humano(op.conversa_id, 'ATENÇÃO: a marcação automática ficou INCERTA (o Klingo não confirmou). Conferir na agenda do Klingo se o horário ' || to_char(coalesce((op.detalhe ->> 'data')::date, current_date), 'DD/MM') || ' ' || coalesce(op.detalhe ->> 'hora', '?') || ' foi marcado ANTES de marcar de novo. Código: ' || coalesce(v_cod, '?'), 'media', 'marcar_incerto');
  elsif v_cod in ('plano_inativo', 'plano_desconhecido', 'sem_medico') then
    perform public.fluxo_finalizar_humano(op.conversa_id, 'Marcação automática não feita: convênio ' || v_plano || ' não aceito para este horário (' || v_cod || '). Resolver o convênio com o paciente.', 'baixa', 'marcar_plano');
  else
    perform public.fluxo_finalizar_humano(op.conversa_id, 'Marcação automática não feita (' || coalesce(v_cod, 'falha') || '). A equipe confirma o horário com o paciente.', 'baixa', 'marcar_equipe');
  end if;
  return jsonb_build_object('ok', true, 'estado', v_est);
end $function$;

