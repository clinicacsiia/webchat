-- public.chat_disponibilidade_responder(p_conversa uuid, p_token text, p_id uuid, p_aceita boolean)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_disponibilidade_responder(p_conversa uuid, p_token text, p_id uuid, p_aceita boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.disponibilidade_pedido; o public.disponibilidade_oportunidade; pa public.pre_agendamentos;
begin
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  r := public.disponibilidade_do_paciente(p_conversa, p_id);
  select * into o from public.disponibilidade_oportunidade where pedido_id = r.id and estado = 'notificada' order by encontrada_em desc limit 1;
  if o.id is null or o.valida_ate <= now() then
    perform public.disponibilidade_mudar_estado(r.id, 'ativa', 'paciente', jsonb_build_object('motivo', 'oportunidade_expirada'));
    return jsonb_build_object('ok', false, 'motivo', 'oportunidade_expirada', 'mensagem', 'Esse horário já não está mais disponível. Continuamos procurando para você.');
  end if;
  if not p_aceita then
    update public.disponibilidade_oportunidade set estado = 'descartada' where id = o.id;
    perform public.disponibilidade_mudar_estado(r.id, 'ativa', 'paciente', jsonb_build_object('motivo', 'recusou'));
    return jsonb_build_object('ok', true, 'acao', 'continuar_procurando');
  end if;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if pa.id is null or pa.status in ('agendado', 'cancelado') then return jsonb_build_object('ok', false, 'motivo', 'pedido_' || coalesce(pa.status, 'inexistente')); end if;
  update public.disponibilidade_oportunidade set estado = 'aceita' where id = o.id;
  perform public.disponibilidade_mudar_estado(r.id, 'aguardando_resposta', 'paciente', jsonb_build_object('oportunidade', o.id));
  update public.pre_agendamentos set status = 'rascunho', escolha_horario = null, data_desejada = null, hora_desejada = null, etapa = 'data_hora', conferencia_status = null, conferencia_detalhe = null, atualizado_em = now()
   where conversa_id = p_conversa and status = 'pronto';
  update public.conversas set status = case when status = 'encerrada' then 'aguardando' else status end where id = p_conversa;
  perform public.fluxo_set(p_conversa, '{"sem_horario": false, "confirmado": false, "oferta_pendente": null}'::jsonb);
  perform public.fluxo_perguntar(p_conversa, 'horario', 'Vou conferir os horários disponíveis agora. Escolha o que preferir; só fica marcado depois da confirmação.');
  return jsonb_build_object('ok', true, 'acao', 'abrir_calendario');
end $function$;

