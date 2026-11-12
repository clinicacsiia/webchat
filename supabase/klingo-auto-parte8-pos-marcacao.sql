-- Autoatendimento com a API do Klingo — Parte 8: depois da marcação (ver, cancelar e remarcar pelo chat). Escrito em 12/11/2026.
--
-- FLUXOGRAMA: depois do cartão do agendamento o paciente vê um menu. "Cancelar": confere o prazo da clínica (config.klingo_pos_prazo_horas, padrão 24) -> pede confirmação ("Sim, cancelar") -> cria a operação
--   "cancelar" (chave única, duplo toque = 1 só) -> klingo-executar abre a sessão conferida, vê se o voucher está entre as marcações ATIVAS do paciente e chama DELETE /voucher -> pedido "cancelado" e conversa encerrada.
--   "Remarcar": confere o prazo -> volta ao passo do horário (o horário atual só é trocado quando o novo estiver confirmado) -> operação "remarcar" (a API cancela o antigo sozinha ao criar o novo).
--   Só vale para o que ESTA conversa marcou (origem chat_api) e só com klingo_api_pos ligado. Qualquer dúvida (prazo, falha, incerto) chama a equipe sem mexer no agendamento.
-- Versão 1.0 — 12/11/2026 / Mudança: primeira versão (etapa 4 do planejamento, sem depender de IA).
-- Para voltar atrás: update public.config set valor = 'nao' where chave = 'klingo_api_pos'; (o menu volta a mostrar só "ver", "falar com a equipe" e "tudo certo").

insert into public.fluxo_texto (chave, texto) values
  ('remarcando', 'Perfeito! Estou remarcando o seu horário no sistema da clínica. Leva só alguns segundos…'),
  ('cancelando', 'Certo. Estou cancelando no sistema da clínica. Leva só alguns segundos…'),
  ('remarcado', 'Pronto, {nome}! Remarquei o seu agendamento. ✅'),
  ('cancelado', 'Pronto, {nome}: o agendamento foi cancelado e o horário voltou para a agenda da clínica. Quando quiser marcar de novo, é só fazer um novo pedido.'),
  ('pos_cancelar_confirma', 'Você quer mesmo cancelar este agendamento?'),
  ('pos_prazo', 'Para cancelar ou remarcar com menos de {horas} horas de antecedência eu preciso da nossa equipe. Já chamei uma pessoa para te ajudar.'),
  ('pos_remarcar_inicio', 'Claro! Vamos escolher o novo horário. O horário atual só é trocado quando o novo estiver confirmado.'),
  ('cancelar_equipe', 'Não consegui cancelar sozinho, mas já avisei a nossa equipe e uma pessoa resolve com você.')
on conflict (chave) do nothing;

-- Menu depois da marcação: com klingo_api_pos ligado e um agendamento feito por este chat, aparecem "Remarcar" e "Cancelar".
create or replace function public.fluxo_pos_menu(p_conversa uuid, p_texto text default null) returns void
language plpgsql security definer set search_path to '' as $$
declare v_it jsonb := jsonb_build_array(jsonb_build_object('valor', 'ver', 'rotulo', 'Ver a minha marcação'));
begin
  update public.conversa_fluxo set passo = 'pos_menu', atualizado_em = now() where conversa_id = p_conversa;
  if public.klingo_ativo(p_conversa, 'klingo_api_pos')
     and exists (select 1 from public.pre_agendamentos pa where pa.conversa_id = p_conversa and pa.agendado_origem = 'chat_api' and pa.status = 'agendado') then
    v_it := v_it || jsonb_build_object('valor', 'remarcar', 'rotulo', 'Remarcar') || jsonb_build_object('valor', 'cancelar', 'rotulo', 'Cancelar') || jsonb_build_object('valor', 'equipe', 'rotulo', 'Falar com a equipe');
  else
    v_it := v_it || jsonb_build_object('valor', 'equipe', 'rotulo', 'Remarcar, cancelar ou falar com a equipe');
  end if;
  v_it := v_it || jsonb_build_object('valor', 'fim', 'rotulo', 'Está tudo certo, obrigado');
  perform public.fluxo_dizer(p_conversa, coalesce(p_texto, public.fluxo_t('pos_menu', public.fluxo_ctx(p_conversa))), public.fluxo_escolha('pos_menu', v_it));
end $$;

create or replace function public.fluxo_pos_responder(p_conversa uuid, p_valor text) returns void
language plpgsql security definer set search_path to '' as $$
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
  end if;
end $$;

-- A operação de marcar vira "remarcar" quando a conversa está remarcando: a chave leva o voucher antigo e a API recebe a "remarcacao".
create or replace function public.klingo_operacao_criar(p_conversa uuid) returns uuid
language plpgsql security definer set search_path to '' as $$
declare pa public.pre_agendamentos; e jsonb; o public.klingo_oferta; v_chave text; v_op uuid; v_rem jsonb; v_tipo text;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  e := pa.escolha_horario -> 0;
  select * into o from public.klingo_oferta where conversa_id = p_conversa and chave = e ->> 'klingo_chave';
  select f.dados -> 'remarcando' into v_rem from public.conversa_fluxo f where f.conversa_id = p_conversa;
  v_tipo := case when jsonb_typeof(v_rem) = 'object' then 'remarcar' else 'marcar' end;
  v_chave := v_tipo || ':' || pa.id::text || ':' || coalesce(v_rem ->> 'voucher', '') || ':' || (e ->> 'klingo_chave');
  insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, detalhe)
  values (p_conversa, pa.id, v_tipo, v_chave, jsonb_build_object('chave', e ->> 'klingo_chave', 'data', e ->> 'data', 'hora', e ->> 'hora', 'procedimento', o.procedimento, 'plano', o.plano)
          || case when v_tipo = 'remarcar' then jsonb_build_object('remarcacao', v_rem ->> 'voucher') else '{}'::jsonb end)
  on conflict (chave_idem) do nothing returning id into v_op;
  if v_op is null then select id into v_op from public.klingo_operacao where chave_idem = v_chave; return v_op; end if;
  perform public.klingo_operacao_disparar(v_op);
  perform public.klingo_medir('op_criada');
  return v_op;
end $$;

-- fluxo_finalizar: remarcação que a automação não pode fazer vai para a equipe SEM mexer no agendamento atual
create or replace function public.fluxo_finalizar(p_conversa uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare ctx jsonb := public.fluxo_ctx(p_conversa); v_pode jsonb; v_op uuid; v_rem jsonb; pa public.pre_agendamentos;
begin
  select f.dados -> 'remarcando' into v_rem from public.conversa_fluxo f where f.conversa_id = p_conversa;
  begin v_pode := public.klingo_pode_marcar(p_conversa); exception when others then v_pode := jsonb_build_object('ok', false, 'motivo', 'erro_interno'); end;
  if coalesce((v_pode ->> 'ok')::boolean, false) then
    begin
      v_op := public.klingo_operacao_criar(p_conversa);
      update public.conversa_fluxo set passo = 'marcando', dados = dados || jsonb_build_object('enviado_em', now(), 'operacao', v_op), atualizado_em = now() where conversa_id = p_conversa;
      perform public.fluxo_dizer(p_conversa, public.fluxo_t(case when jsonb_typeof(v_rem) = 'object' then 'remarcando' else 'marcando' end, ctx), jsonb_build_object('tipo', 'marcando', 'operacao', v_op));
      return;
    exception when others then null;
    end;
  end if;
  if jsonb_typeof(v_rem) = 'object' then
    select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
    perform public.fluxo_nota(p_conversa, 'Remarcação pedida pelo chat, mas a automação não pôde fazer (' || coalesce(v_pode ->> 'motivo', '?') || '). O agendamento atual (voucher ' || coalesce(v_rem ->> 'voucher', '?') || ') continua valendo; novo horário escolhido: '
      || coalesce((pa.escolha_horario -> 0 ->> 'data') || ' ' || (pa.escolha_horario -> 0 ->> 'hora'), 'nenhum') || '.');
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('marcar_equipe', ctx));
    perform public.fluxo_transferir(p_conversa, 'Paciente quer remarcar o agendamento (novo horário escolhido no chat).', 'baixa', false);
    update public.conversa_fluxo set dados = dados - 'remarcando', atualizado_em = now() where conversa_id = p_conversa;
    return;
  end if;
  perform public.fluxo_finalizar_humano(p_conversa, case when coalesce(v_pode ->> 'motivo', 'desligado') in ('desligado', 'ja_agendado') then null else 'Automação não aplicada: ' || (v_pode ->> 'motivo') end);
end $$;

-- Resultado da operação: marcar, remarcar e cancelar
create or replace function public.klingo_operacao_concluir(p_op uuid, p_estado text, p_r jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
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
end $$;

-- klingo_pode_marcar: a conversa que está REMARCANDO pode passar, só se o agendamento atual foi feito por este chat e o pós está ligado
create or replace function pg_temp.trocar(t text, velho text, novo text) returns text language plpgsql as $t$
begin
  if position(novo in t) > 0 then return t; end if;   -- já aplicado: a migração pode ser repetida sem estragar
  if (length(t) - length(replace(t, velho, ''))) / greatest(length(velho), 1) <> 1 then raise exception 'trecho nao encontrado exatamente uma vez: %', left(velho, 60); end if;
  return replace(t, velho, novo);
end $t$;
do $do$ declare d text;
begin
  d := pg_get_functiondef('public.klingo_pode_marcar(uuid)'::regprocedure);
  d := pg_temp.trocar(d, $a$v_novo boolean := false;
begin$a$, $a$v_novo boolean := false; v_rem boolean := false;
begin$a$);
  d := pg_temp.trocar(d, $a$  if pa.status = 'agendado' or pa.id is null then return jsonb_build_object('ok', false, 'motivo', 'ja_agendado'); end if;$a$,
    $a$  v_rem := coalesce((select jsonb_typeof(f.dados -> 'remarcando') = 'object' from public.conversa_fluxo f where f.conversa_id = p_conversa), false);
  if pa.id is null or (pa.status = 'agendado' and not v_rem) then return jsonb_build_object('ok', false, 'motivo', 'ja_agendado'); end if;
  if v_rem and (pa.agendado_origem is distinct from 'chat_api' or not public.klingo_ativo(p_conversa, 'klingo_api_pos')) then return jsonb_build_object('ok', false, 'motivo', 'remarcar_desligado'); end if;$a$);
  d := pg_temp.trocar(d, $a$  return jsonb_build_object('ok', true, 'novo', v_novo);$a$, $a$  return jsonb_build_object('ok', true, 'novo', v_novo, 'remarcar', v_rem);$a$);
  execute d;

  -- fluxo_avancar: as respostas do passo "pos_cancelar" vão para o mesmo tratamento do menu; texto livre nesse passo volta ao menu
  d := pg_get_functiondef('public.fluxo_avancar(uuid, jsonb)'::regprocedure);
  d := pg_temp.trocar(d, $a$    if v_passo = 'pos_menu' then   -- klingo-auto: menu depois da marcação$a$, $a$    if v_passo in ('pos_menu', 'pos_cancelar') then   -- klingo-auto: menu depois da marcação$a$);
  d := pg_temp.trocar(d, $a$    elsif v_passo in ('marcado', 'pos_menu') then$a$, $a$    elsif v_passo in ('marcado', 'pos_menu', 'pos_cancelar') then$a$);
  execute d;

  -- chat_horario_escolher: quem está REMARCANDO precisa conseguir gravar o horário novo mesmo com o pedido "agendado"
  d := pg_get_functiondef('public.chat_horario_escolher(uuid, text, integer, date, text, text)'::regprocedure);
  d := pg_temp.trocar(d, $a$  where conversa_id = p_conversa and status not in ('agendado','cancelado');$a$, $a$  where conversa_id = p_conversa and (status not in ('agendado','cancelado')
        or (status = 'agendado' and exists (select 1 from public.conversa_fluxo f where f.conversa_id = p_conversa and jsonb_typeof(f.dados -> 'remarcando') = 'object')));   -- klingo-auto: remarcar$a$);
  execute d;

  -- autogestão: cancelar/remarcar são liberados quando a marcação já está em 100% e estável; recuam junto com ela
  d := pg_get_functiondef('public.klingo_autogestao()'::regprocedure);
  d := pg_temp.trocar(d, $a$    acoes := array_append(acoes, 'marcar:recuou');$a$, $a$    acoes := array_append(acoes, 'marcar:recuou');
    if public.klingo_cfg('klingo_api_pos', 'teste') = 'sim' then perform public.klingo_decidir('klingo_api_pos', 'teste', jsonb_build_object('motivo', 'a marcação automática recuou'), null); end if;$a$);
  d := pg_temp.trocar(d, $a$  return jsonb_build_object('ligada', true, 'acoes', to_jsonb(acoes)$a$, $a$  if public.klingo_cfg('klingo_api_marcar', 'nao') = 'sim' and v_pct >= 100 and public.klingo_cfg('klingo_api_pos', 'teste') = 'teste' and v_dp is not null and v_dp < now() - interval '2 days'
     and not (acoes @> array['marcar:avancou_pct']) and not (acoes @> array['marcar:recuou']) then
    perform public.klingo_decidir('klingo_api_pos', 'sim', jsonb_build_object('percentual', v_pct), 'Cancelar e remarcar pelo chat foram liberados (a marcação automática já está em 100% e estável).');
    acoes := array_append(acoes, 'pos:avancou');
  end if;
  return jsonb_build_object('ligada', true, 'acoes', to_jsonb(acoes)$a$);
  execute d;
end $do$;

do $do$ declare f text; begin
  for f in select unnest(array['fluxo_pos_menu(uuid, text)', 'fluxo_pos_responder(uuid, text)', 'klingo_operacao_criar(uuid)', 'fluxo_finalizar(uuid)', 'klingo_operacao_concluir(uuid, text, jsonb)']) loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $do$;
