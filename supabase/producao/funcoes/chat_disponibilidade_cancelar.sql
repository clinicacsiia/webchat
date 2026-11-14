-- public.chat_disponibilidade_cancelar(p_conversa uuid, p_token text, p_id uuid)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_disponibilidade_cancelar(p_conversa uuid, p_token text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.disponibilidade_pedido;
begin
  perform public.chat_valida(p_conversa, p_token);
  r := public.disponibilidade_do_paciente(p_conversa, p_id);
  if r.estado in ('expirada', 'cancelada', 'convertida_em_agendamento') then return jsonb_build_object('ok', true, 'estado', r.estado, 'ja_terminada', true); end if;
  perform public.disponibilidade_mudar_estado(r.id, 'cancelada', 'paciente');
  update public.disponibilidade_oportunidade set estado = 'descartada' where pedido_id = r.id and estado in ('nova', 'notificada');
  return jsonb_build_object('ok', true, 'estado', 'cancelada');
end $function$;

