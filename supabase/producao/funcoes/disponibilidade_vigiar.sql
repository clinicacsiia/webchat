-- public.disponibilidade_vigiar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_vigiar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_exp integer := 0; v_ent integer; v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo(); v_alvos jsonb; v_disp boolean := false; r record;
begin
  if not pg_try_advisory_xact_lock(hashtext('disponibilidade_vigiar')) then return jsonb_build_object('ocupado', true); end if;
  v_exp := 0;
  for r in select id from public.disponibilidade_pedido where estado in ('ativa', 'oportunidade_identificada', 'notificada', 'aguardando_resposta') and expira_em <= now() loop
    if public.disponibilidade_mudar_estado(r.id, 'expirada', 'sistema', jsonb_build_object('motivo', 'periodo_terminou')) then v_exp := v_exp + 1; end if;
  end loop;
  update public.disponibilidade_oportunidade set estado = 'descartada' where estado in ('nova', 'notificada') and pedido_id in (select id from public.disponibilidade_pedido where estado in ('expirada', 'cancelada', 'convertida_em_agendamento'));
  for r in select distinct o.pedido_id from public.disponibilidade_oportunidade o where o.estado in ('nova', 'notificada') and o.valida_ate <= now() loop
    update public.disponibilidade_oportunidade set estado = 'expirada' where pedido_id = r.pedido_id and estado in ('nova', 'notificada') and valida_ate <= now();
    update public.disponibilidade_notificacao set estado = 'falhou', detalhe = 'oportunidade_expirada' where pedido_id = r.pedido_id and estado = 'pendente';
    perform public.disponibilidade_mudar_estado(r.pedido_id, 'ativa', 'sistema', jsonb_build_object('motivo', 'oportunidade_expirou'));
  end loop;
  v_ent := public.disponibilidade_entregar_pendentes();
  v_alvos := public.disponibilidade_alvos(10);
  if jsonb_array_length(v_alvos) > 0 and v_base <> '' and v_seg is not null then
    begin
      perform net.http_post(url := v_base || 'disponibilidade-vigia', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg), body := jsonb_build_object('alvos', v_alvos), timeout_milliseconds := 110000);
      v_disp := true;
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('expiradas', v_exp, 'entregues', v_ent, 'alvos', jsonb_array_length(v_alvos), 'disparou', v_disp);
end $function$;

