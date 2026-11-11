-- public.fluxo_pos_aplicar(p_conversa uuid, p_passo text, v text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_pos_aplicar(p_conversa uuid, p_passo text, v text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; ctx jsonb := public.fluxo_ctx(p_conversa); v_orig uuid; v_item text; v_ok boolean; v_f bigint;
begin
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  v_orig := coalesce(nullif(d ->> 'pos_origem', '')::uuid, p_conversa);
  v_item := coalesce(d ->> 'pos_item', 'o exame');
  ctx := ctx || jsonb_build_object('item', v_item);
  if p_passo = 'exame_aberto' then
    case v
    when 'compareceu' then
      perform public.agendamento_fechar_interno(v_orig, 'compareceu', 'paciente', null, 'Informado pelo paciente no chat.');
      perform public.fluxo_set(p_conversa, jsonb_build_object('pos_passo', null, 'assunto', 'Exame em aberto', 'assunto_texto', left('O paciente diz que COMPARECEU: ' || v_item || '. Conferir no sistema.', 500)));
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('exame_aberto_obrigado', ctx));
      return '{"ok": true, "transferir": true}';
    when 'cancelar' then
      perform public.agendamento_fechar_interno(v_orig, 'cancelou', 'paciente', null, 'Pedido de cancelamento feito pelo paciente no chat.');
      perform public.fluxo_set(p_conversa, jsonb_build_object('pos_passo', null, 'assunto', 'Exame em aberto', 'assunto_texto', left('O paciente quer CANCELAR: ' || v_item || '. Cancelar no sistema e confirmar com ele.', 500)));
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('exame_aberto_cancelar', ctx));
      return '{"ok": true, "transferir": true}';
    when 'faltei' then
      perform public.agendamento_fechar_interno(v_orig, 'faltou', 'paciente', null, 'Informado pelo paciente no chat.');
      perform public.fluxo_set(p_conversa, '{"pos_passo": "remarcar_falta"}');
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('exame_aberto_faltei', ctx));
    when 'remarcar' then
      perform public.agendamento_fechar_interno(v_orig, 'remarcou', 'paciente', null, 'O paciente pediu para remarcar pelo chat.');
      update public.agendamento_fechamento set remarcacao = 'pendente' where conversa_id = v_orig and desfecho = 'remarcou' and remarcacao is null;
      return public.fluxo_pos_aplicar(p_conversa, 'remarcar_falta', 'sim');
    else
      return '{"ok": false}';
    end case;
  end if;
  select id into v_f from public.agendamento_fechamento where conversa_id = v_orig and desfecho in ('faltou', 'remarcou') and remarcacao in ('pendente', 'pedida')
   order by fechado_em desc limit 1;
  case v
  when 'sim' then
    v_ok := coalesce((d ->> 'pos_copiar')::boolean, true) and public.agendamento_preparar_remarcacao(p_conversa, v_orig);
    if v_f is not null then
      update public.agendamento_fechamento set remarcacao = 'aceita', remarcacao_conversa = p_conversa, atualizado_em = now() where id = v_f;
    end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('pos_passo', null, 'motivo', 'exame', 'confirmado', false, 'sem_horario', false, 'refazer', case when v_ok then null else 'pedido' end,
      'medico_feito', true, 'mudou', null));
    return jsonb_build_object('ok', true, 'aviso', public.fluxo_t(case when v_ok then 'remarcar_falta_ok' else 'remarcar_falta_do_zero' end, ctx));
  when 'atendente' then
    if v_f is not null then update public.agendamento_fechamento set remarcacao = 'pedida', atualizado_em = now() where id = v_f; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('pos_passo', null, 'assunto', 'Remarcar falta', 'assunto_texto', left('O paciente quer remarcar ' || v_item || ' com um atendente.', 500)));
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('remarcar_falta_atendente', ctx));
    return '{"ok": true, "transferir": true}';
  when 'nao' then
    if v_f is not null then update public.agendamento_fechamento set remarcacao = 'recusada', atualizado_em = now() where id = v_f; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('pos_passo', null, 'assunto', 'Remarcar falta', 'assunto_texto', left('O paciente NÃO quer remarcar ' || v_item || '.', 500)));
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('remarcar_falta_nao', ctx));
    return '{"ok": true, "transferir": true}';
  else
    return '{"ok": false}';
  end case;
end $function$;

