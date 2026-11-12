-- public.fluxo_pos_responder(p_conversa uuid, p_valor text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_pos_responder(p_conversa uuid, p_valor text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  pa public.pre_agendamentos; e jsonb; v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado']; v_txt text; ctx jsonb := public.fluxo_ctx(p_conversa);
  v_h integer := coalesce(nullif(public.klingo_cfg('klingo_pos_prazo_horas', '24'), '')::integer, 24); v_vou text; v_inicio timestamp; v_op uuid; v_quando text;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  e := pa.escolha_horario -> 0; v_vou := pa.klingo_marcacoes[1];
  if jsonb_typeof(e) = 'object' and (e ->> 'data') ~ '^\d{4}-\d{2}-\d{2}$' then
    v_quando := v_dias[extract(dow from (e ->> 'data')::date)::int + 1] || ', ' || to_char((e ->> 'data')::date, 'DD/MM') || ' às ' || (e ->> 'hora');
  end if;
  if p_valor = 'ver' then
    v_txt := coalesce(nullif(e ->> 'procedimento', ''), 'Atendimento') || E'\n' || coalesce(v_quando, '')
             || coalesce(E'\n' || nullif(e ->> 'unidade', ''), '') || coalesce(E'\nCom ' || nullif(e ->> 'profissional', ''), '') || coalesce(E'\nProtocolo: ' || v_vou, '');
    perform public.fluxo_pos_menu(p_conversa, 'Sua marcação:' || E'\n' || v_txt);
  elsif p_valor in ('cancelar', 'remarcar') then
    if not (public.klingo_ativo(p_conversa, 'klingo_api_pos') and pa.agendado_origem = 'chat_api' and pa.status = 'agendado' and v_vou ~ '^[0-9]+$' and v_quando is not null) then
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('pos_equipe', ctx));
      perform public.fluxo_transferir(p_conversa, 'Paciente quer remarcar, cancelar ou falar com a equipe depois da marcação automática.', 'baixa', true);
      return;
    end if;
    v_inicio := ((e ->> 'data') || ' ' || (e ->> 'hora'))::timestamp;
    if v_inicio - (now() at time zone 'America/Bahia') < make_interval(hours => v_h) then
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('pos_prazo', ctx || jsonb_build_object('horas', v_h::text)));
      perform public.fluxo_transferir(p_conversa, 'Paciente quer ' || p_valor || ' o agendamento ' || v_vou || ' (' || v_quando || ') com menos de ' || v_h || ' h de antecedência.', 'media', true);
      return;
    end if;
    if p_valor = 'cancelar' then
      update public.conversa_fluxo set passo = 'pos_cancelar', atualizado_em = now() where conversa_id = p_conversa;
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('pos_cancelar_confirma', ctx) || E'\n\n' || coalesce(nullif(e ->> 'procedimento', ''), 'Atendimento') || E'\n' || v_quando || coalesce(E'\n' || nullif(e ->> 'unidade', ''), ''),
        public.fluxo_escolha('pos_cancelar', jsonb_build_array(jsonb_build_object('valor', 'cancelar_sim', 'rotulo', 'Sim, cancelar'), jsonb_build_object('valor', 'cancelar_nao', 'rotulo', 'Não, manter o agendamento'))));
    else
      -- o agendamento atual continua valendo até o novo ser confirmado: guardamos qual é e voltamos à escolha do horário
      delete from public.klingo_oferta where conversa_id = p_conversa;
      update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null, atualizado_em = now() where id = pa.id;
      perform public.fluxo_set(p_conversa, jsonb_build_object('remarcando', jsonb_build_object('voucher', v_vou, 'data', e ->> 'data', 'hora', e ->> 'hora', 'procedimento', e ->> 'procedimento'), 'confirmado', false, 'sem_horario', false));
      perform public.fluxo_perguntar(p_conversa, 'horario', public.fluxo_t('pos_remarcar_inicio', ctx));
    end if;
  elsif p_valor = 'cancelar_sim' then
    if not (public.klingo_ativo(p_conversa, 'klingo_api_pos') and pa.agendado_origem = 'chat_api' and pa.status = 'agendado' and v_vou ~ '^[0-9]+$') then
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('pos_equipe', ctx));
      perform public.fluxo_transferir(p_conversa, 'Paciente quer cancelar o agendamento depois da marcação automática.', 'baixa', true);
      return;
    end if;
    select id into v_op from public.klingo_operacao where conversa_id = p_conversa and tipo = 'cancelar' and estado in ('pendente', 'executando') limit 1;
    if v_op is not null then return; end if;   -- duplo toque: já está cancelando
    insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, detalhe)
    values (p_conversa, pa.id, 'cancelar', 'cancelar:' || pa.id::text || ':' || v_vou || ':' || (select count(*) from public.klingo_operacao x where x.conversa_id = p_conversa and x.tipo = 'cancelar')::text,
            jsonb_build_object('voucher', v_vou)) returning id into v_op;
    update public.conversa_fluxo set passo = 'marcando', atualizado_em = now() where conversa_id = p_conversa;
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('cancelando', ctx), jsonb_build_object('tipo', 'marcando', 'operacao', v_op));
    perform public.klingo_operacao_disparar(v_op);
    perform public.klingo_medir('op_criada');
  elsif p_valor = 'cancelar_nao' then
    perform public.fluxo_pos_menu(p_conversa);
  elsif p_valor = 'equipe' then
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('pos_equipe', ctx));
    perform public.fluxo_transferir(p_conversa, 'Paciente quer remarcar, cancelar ou falar com a equipe depois da marcação automática.', 'baixa', true);
  else
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('pos_fim', ctx), jsonb_build_object('tipo', 'nova'));
    update public.conversa_fluxo set passo = 'marcado', atualizado_em = now() where conversa_id = p_conversa;
    -- quadro "Agendado pela API": o paciente disse que está tudo certo e ninguém da equipe entrou, então a conversa é encerrada (se ele voltar, cai de novo no menu)
    update public.conversas set status = 'encerrada', encerrada_em = now(), motivo_encerramento = 'agendado', encerramento_origem = 'sistema'
     where id = p_conversa and status <> 'encerrada' and primeiro_humano_em is null and exists (select 1 from public.pre_agendamentos x where x.conversa_id = p_conversa and x.agendado_origem = 'chat_api');
  end if;
end $function$;

