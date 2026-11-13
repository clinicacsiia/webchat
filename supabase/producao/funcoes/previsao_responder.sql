-- public.previsao_responder(p_conversa uuid, p_passo text, p_valor text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.previsao_responder(p_conversa uuid, p_passo text, p_valor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_prev jsonb; v_hoje date := (now() at time zone 'America/Bahia')::date; v_de date; v_ate date; v_slots jsonb; v_s1 jsonb; v_fim_mes date;
begin
  select coalesce(dados -> 'previsao', '{}'::jsonb) into v_prev from public.conversa_fluxo where conversa_id = p_conversa;
  if jsonb_typeof(v_prev) <> 'object' then v_prev := '{}'::jsonb; end if;
  v_fim_mes := (date_trunc('month', v_hoje) + interval '1 month - 1 day')::date;

  if p_passo = 'previsao_turno' then
    if p_valor not in ('manha', 'tarde', 'qualquer') then return '{"ok": false}'::jsonb; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', v_prev || jsonb_build_object('turno', p_valor, 'etapa', 'periodo')));
    return '{"ok": true}'::jsonb;

  elsif p_passo = 'previsao_periodo' then
    if p_valor not in ('quinze', 'mes', 'proximo_mes', 'tres_meses', 'depois') then return '{"ok": false}'::jsonb; end if;
    select case p_valor when 'quinze' then v_hoje when 'mes' then v_hoje when 'proximo_mes' then (v_fim_mes + 1) when 'tres_meses' then v_hoje + 45 else v_hoje + 90 end,
           case p_valor when 'quinze' then v_hoje + 15 when 'mes' then v_fim_mes when 'proximo_mes' then (date_trunc('month', v_fim_mes + 1) + interval '1 month - 1 day')::date when 'tres_meses' then v_hoje + 105 else v_hoje + 365 end
      into v_de, v_ate;
    v_prev := v_prev || jsonb_build_object('de', v_de, 'ate', v_ate, 'etapa', 'decide');
    v_slots := public.previsao_buscar(p_conversa, coalesce(v_prev ->> 'turno', 'qualquer'), v_de, v_ate, 120);
    v_s1 := v_slots -> 0;
    if v_s1 is not null then
      perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', v_prev, 'oferta_pendente', jsonb_build_object('n', 1, 'origem', 'previsao', 'original', 'sua preferência', 'slots', v_slots,
        'texto', replace(coalesce((select valor from public.config where chave = 'previsao_oferta_texto'), ''), '{oferta}', public.pedido_slot_texto(v_s1)))));
    else
      perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', v_prev));
    end if;
    return '{"ok": true}'::jsonb;

  elsif p_passo = 'previsao_decide' then
    if p_valor = 'lista' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', v_prev || jsonb_build_object('etapa', 'antecedencia')));
      return '{"ok": true}'::jsonb;
    elsif p_valor = 'calendario' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', null, 'oferta_pendente', null, 'sem_horario', false, 'confirmado', false));
      return jsonb_build_object('ok', true, 'aviso', coalesce((select valor from public.config where chave = 'pedido_escolha_texto'), ''));
    end if;
    return '{"ok": false}'::jsonb;

  elsif p_passo = 'previsao_antecedencia' then
    if p_valor not in ('imediato', '1_dia', '1_semana', '1_mes') or v_prev ->> 'turno' is null or v_prev ->> 'de' is null then return '{"ok": false}'::jsonb; end if;
    insert into public.pedido_previsao (conversa_id, turno, de, ate, antecedencia) values (p_conversa, v_prev ->> 'turno', (v_prev ->> 'de')::date, (v_prev ->> 'ate')::date, p_valor)
    on conflict (conversa_id) do update set turno = excluded.turno, de = excluded.de, ate = excluded.ate, antecedencia = excluded.antecedencia, status = 'aguardando', vaga = null, vaga_em = null, atualizada_em = now();
    perform public.fluxo_set(p_conversa, jsonb_build_object('previsao', null, 'oferta_pendente', null, 'sem_horario', true));
    perform public.fluxo_nota(p_conversa, 'PREVISÃO (NÃO É AGENDAMENTO): paciente na lista de espera. Turno: ' || case v_prev ->> 'turno' when 'manha' then 'manhã' when 'tarde' then 'tarde' else 'tanto faz' end
      || '. Período: ' || to_char((v_prev ->> 'de')::date, 'DD/MM/YYYY') || ' a ' || to_char((v_prev ->> 'ate')::date, 'DD/MM/YYYY')
      || '. Pode ser chamado com antecedência de: ' || case p_valor when 'imediato' then 'até 24 horas' when '1_dia' then '1 dia' when '1_semana' then '1 semana' else '1 mês' end || '. Se surgir vaga, a atendente oferece.');
    return jsonb_build_object('ok', true, 'aviso', coalesce((select valor from public.config where chave = 'previsao_final_texto'), ''));
  end if;
  return '{"ok": false}'::jsonb;
end $function$
;
