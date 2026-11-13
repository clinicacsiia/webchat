-- public.previsao_iniciar(p_conversa uuid, p_decidir boolean, p_aviso text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.previsao_iniciar(p_conversa uuid, p_decidir boolean DEFAULT false, p_aviso text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_prev jsonb;
begin
  select dados -> 'previsao' into v_prev from public.conversa_fluxo where conversa_id = p_conversa;
  perform public.fluxo_set(p_conversa, jsonb_build_object('oferta_pendente', null, 'sem_horario', false, 'confirmado', false,
    'previsao', case when p_decidir and jsonb_typeof(v_prev) = 'object' then v_prev || jsonb_build_object('etapa', 'decide') else jsonb_build_object('etapa', 'turno') end));
  update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null, etapa = 'data_hora' where conversa_id = p_conversa;
  perform public.fluxo_nota(p_conversa, case when p_decidir then 'Paciente recusou os horários oferecidos dentro do filtro dele: perguntou-se se quer ficar na lista de previsão.' else 'Nenhum horário serviu ao paciente: o assistente pergunta turno e período para procurar.' end);
  return jsonb_build_object('ok', true, 'aviso', p_aviso);
end $function$
;
