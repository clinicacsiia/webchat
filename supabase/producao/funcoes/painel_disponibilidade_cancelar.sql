-- public.painel_disponibilidade_cancelar(p_id uuid, p_motivo text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_disponibilidade_cancelar(p_id uuid, p_motivo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.disponibilidade_pedido;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  select * into r from public.disponibilidade_pedido where id = p_id;
  if r.id is null then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  if r.estado in ('expirada', 'cancelada', 'convertida_em_agendamento') then return jsonb_build_object('ok', true, 'estado', r.estado, 'ja_terminada', true); end if;
  perform public.disponibilidade_mudar_estado(r.id, 'cancelada', 'equipe:' || coalesce(auth.uid()::text, '?'), jsonb_build_object('motivo', left(coalesce(p_motivo, ''), 200)));
  update public.disponibilidade_oportunidade set estado = 'descartada' where pedido_id = r.id and estado in ('nova', 'notificada');
  return jsonb_build_object('ok', true, 'estado', 'cancelada');
end $function$;

