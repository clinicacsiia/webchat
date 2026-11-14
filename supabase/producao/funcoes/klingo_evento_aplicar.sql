-- public.klingo_evento_aplicar(p jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_evento_aplicar(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ev text := left(coalesce(p ->> 'evento', ''), 40); v_id text := left(coalesce(p ->> 'id_marcacao', ''), 30); v_st text := left(coalesce(p ->> 'status', ''), 5); v_nova text := left(coalesce(p ->> 'nova', ''), 30);
  v_hash text; v_ev_id bigint; pa public.pre_agendamentos; v_res text := 'sem_pedido';
begin
  if v_id !~ '^[0-9]+$' then return jsonb_build_object('ok', false, 'motivo', 'id_invalido'); end if;
  v_hash := encode(sha256(convert_to(v_ev || '|' || v_id || '|' || v_st || '|' || coalesce(p ->> 'checkin', '') || '|' || v_nova, 'UTF8')), 'hex');
  insert into public.klingo_evento (hash, evento, id_marcacao, status) values (v_hash, v_ev, v_id, v_st) on conflict (hash) do nothing returning id into v_ev_id;
  if v_ev_id is null then return jsonb_build_object('ok', true, 'duplicado', true); end if;
  select * into pa from public.pre_agendamentos where klingo_marcacoes @> array[v_id] limit 1;
  if pa.id is not null then
    if v_nova ~ '^[0-9]+$' then
      update public.pre_agendamentos set klingo_marcacoes = array_replace(klingo_marcacoes, v_id, v_nova) where id = pa.id;
      perform public.fluxo_nota(pa.conversa_id, 'Klingo avisou: a marcação foi remarcada (a nova é a ' || v_nova || ').');
      v_res := 'remarcada';
    elsif v_st = 'C' and pa.status = 'agendado' then
      update public.pre_agendamentos set status = 'cancelado', conferencia_status = 'sumiu', atualizado_em = now() where id = pa.id;
      perform public.fluxo_nota(pa.conversa_id, 'Klingo avisou: a marcação ' || v_id || ' foi CANCELADA.');
      v_res := 'cancelada';
    elsif nullif(p ->> 'checkin', '') is not null then
      perform public.fluxo_nota(pa.conversa_id, 'Klingo avisou: o paciente fez check-in.');
      v_res := 'checkin';
    else v_res := 'sem_efeito';
    end if;
  end if;
  update public.klingo_evento set processado_em = now(), resultado = v_res where id = v_ev_id;
  perform public.klingo_medir('evento_' || v_res);
  return jsonb_build_object('ok', true, 'resultado', v_res);
end $function$;

