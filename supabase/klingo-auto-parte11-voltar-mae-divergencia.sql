-- FLUXOGRAMA: entrada (paciente no chat; operação de marcação; resposta do executor com o código do motivo) -> validação (voltar só onde não gera problema; um pedido = uma operação; campos digitados x cadastro do Klingo no executor) -> lógica (0 campos diferentes segue; 1 = equipe valida; 2 ou mais = paciente orientado a vir à CSI e equipe avisada; nome da mãe perguntado quando a API está ligada) -> saída (mensagens ao paciente, nota e transferência para a equipe só quando preciso)
-- Versão 1.0 — 12/11/2026 / Mudança: decisões do dono em 12/11/2026 (nome da mãe, voltar seguro, divergência por campos). Só create or replace (mesmas assinaturas e permissões) e um texto novo.
-- ROLLBACK: recriar as funções chat_voltar, klingo_operacao_criar, klingo_operacao_concluir, klingo_autogestao, fluxo_perguntar e fluxo_aplicar a partir de supabase/producao/funcoes/ no commit eec66ec (e apagar o texto 'divergencia_clinica').
-- APLICAR EM PARTES (a ferramenta expira em 60 s): uma parte por vez, na ordem. A parte 11d precisa da parte 10 já aplicada.

-- Parte 11a chat_voltar: não volta durante nem depois da marcação
CREATE OR REPLACE FUNCTION public.chat_voltar(p_conversa uuid, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c public.conversas; v_passo text; v_p text; v_novo text; i int; v_antes bigint;
begin
  perform public.chat_valida(p_conversa, p_token);
  select * into c from public.conversas where id = p_conversa for update;
  select passo into v_passo from public.conversa_fluxo where conversa_id = p_conversa;
  if c.motor <> 'fluxo' or not (c.ia_ativa and c.status = 'aguardando') or v_passo is null then
    raise exception 'Não dá para voltar agora. Veja a última mensagem.' using errcode = '22023';
  end if;
  if v_passo in ('marcando', 'marcado', 'pos_menu', 'pos_cancelar', 'cancelado') or exists (select 1 from public.klingo_operacao o where o.conversa_id = p_conversa and o.estado in ('pendente', 'executando')) then
    raise exception 'Depois de confirmar não dá para voltar por aqui. Use as opções da mensagem.' using errcode = '22023';   -- klingo-auto: voltar durante ou depois da marcação poderia gerar uma 2ª reserva
  end if;
  if v_passo in ('identidade', 'atalho', 'motivo', 'pronto', 'humano', 'assunto_fim') then
    raise exception 'Esta é a primeira pergunta: não há o que corrigir antes dela.' using errcode = '22023';
  end if;
  select coalesce(max(id), 0) into v_antes from public.mensagens where conversa_id = p_conversa;
  -- cada tentativa é ensaiada e desfeita (o erro de propósito desfaz só o que foi mexido no bloco); a primeira que muda a pergunta vale
  foreach i in array array[1, 2, 3, 4, 5, 6, 11, 7, 8, 9, 10] loop   -- klingo-auto: a 11 (CPF e nascimento) vem logo antes do médico/exame
    begin
      perform public.fluxo_voltar_passo(p_conversa, i);
      v_p := public.fluxo_proximo(p_conversa);
      raise exception 'ensaio' using errcode = 'P0001';
    exception when sqlstate 'P0001' then null;
    end;
    if v_p is distinct from v_passo and v_p is not null then
      perform public.fluxo_voltar_passo(p_conversa, i);
      v_novo := public.fluxo_proximo(p_conversa);
      exit;
    end if;
  end loop;
  if v_novo is null or v_novo in ('pronto', v_passo) then
    raise exception 'Não dá para voltar agora. Veja a última mensagem.' using errcode = '22023';
  end if;
  insert into public.fluxo_evento (conversa_id, passo, entrada, entendido) values (p_conversa, v_passo, 'voltar', true);
  perform public.fluxo_perguntar(p_conversa, v_novo, 'Tudo bem, vamos corrigir.');
  return jsonb_build_object('passo', v_novo, 'respostas', public.chat_respostas(p_conversa, v_antes));
end $function$;

-- Parte 11b klingo_operacao_criar: uma operação por pedido
CREATE OR REPLACE FUNCTION public.klingo_operacao_criar(p_conversa uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa public.pre_agendamentos; e jsonb; o public.klingo_oferta; v_chave text; v_op uuid; v_rem jsonb; v_tipo text;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  e := pa.escolha_horario -> 0;
  select * into o from public.klingo_oferta where conversa_id = p_conversa and chave = e ->> 'klingo_chave';
  select f.dados -> 'remarcando' into v_rem from public.conversa_fluxo f where f.conversa_id = p_conversa;
  v_tipo := case when jsonb_typeof(v_rem) = 'object' then 'remarcar' else 'marcar' end;
  v_chave := v_tipo || ':' || pa.id::text || ':' || coalesce(v_rem ->> 'voucher', '') || ':' || (e ->> 'klingo_chave');
  -- klingo-auto: um pedido nunca tem duas operações do mesmo tipo em andamento ou concluídas (mudar o horário não abre uma 2ª reserva)
  select id into v_op from public.klingo_operacao where pre_agendamento_id = pa.id and tipo = v_tipo and estado in ('pendente', 'executando', 'incerto', 'sucesso') and (v_tipo = 'remarcar' or true)
   order by criado_em desc limit 1;
  if v_op is not null and v_tipo = 'marcar' then return v_op; end if;
  if v_op is not null and v_tipo = 'remarcar' and exists (select 1 from public.klingo_operacao where id = v_op and estado in ('pendente', 'executando', 'incerto')) then return v_op; end if;
  v_op := null;
  insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, detalhe)
  values (p_conversa, pa.id, v_tipo, v_chave, jsonb_build_object('chave', e ->> 'klingo_chave', 'data', e ->> 'data', 'hora', e ->> 'hora', 'procedimento', o.procedimento, 'plano', o.plano)
          || case when v_tipo = 'remarcar' then jsonb_build_object('remarcacao', v_rem ->> 'voucher') else '{}'::jsonb end)
  on conflict (chave_idem) do nothing returning id into v_op;
  if v_op is null then select id into v_op from public.klingo_operacao where chave_idem = v_chave; return v_op; end if;
  perform public.klingo_operacao_disparar(v_op);
  perform public.klingo_medir('op_criada');
  return v_op;
end $function$;

-- Parte 11c klingo_operacao_concluir: divergência de cadastro
CREATE OR REPLACE FUNCTION public.klingo_operacao_concluir(p_op uuid, p_estado text, p_r jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  elsif v_cod like 'divergencia_2:%' then
    perform public.fluxo_nota(op.conversa_id, 'Cadastro com 2 ou mais campos diferentes do Klingo (' || substr(v_cod, 15) || '). Nada foi marcado. O paciente foi orientado a comparecer à CSI com documento com foto para marcar e atualizar o cadastro.');
    perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('divergencia_clinica', ctx));
    perform public.fluxo_transferir(op.conversa_id, 'Cadastro do paciente diverge do Klingo em mais de um campo (' || substr(v_cod, 15) || '). Paciente orientado a vir à clínica.', 'baixa', false);
  elsif v_cod like 'divergencia_1:%' then
    perform public.fluxo_finalizar_humano(op.conversa_id, 'Um campo do cadastro diverge do Klingo (' || substr(v_cod, 15) || '). Validar com o paciente: corrigir no Klingo se estiver certo no chat, ou pedir que atualize quando vier à clínica. Nada foi marcado.', 'baixa', 'marcar_equipe');
  elsif v_cod in ('plano_inativo', 'plano_desconhecido', 'sem_medico') then
    perform public.fluxo_finalizar_humano(op.conversa_id, 'Marcação automática não feita: convênio ' || v_plano || ' não aceito para este horário (' || v_cod || '). Resolver o convênio com o paciente.', 'baixa', 'marcar_plano');
  else
    perform public.fluxo_finalizar_humano(op.conversa_id, 'Marcação automática não feita (' || coalesce(v_cod, 'falha') || '). A equipe confirma o horário com o paciente.', 'baixa', 'marcar_equipe');
  end if;
  return jsonb_build_object('ok', true, 'estado', v_est);
end $function$;

-- Parte 11d klingo_autogestao: divergência não derruba a automação (3 trechos)
CREATE OR REPLACE FUNCTION public.klingo_autogestao()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hor text := public.klingo_cfg('klingo_api_horarios', 'nao'); v_mar text := public.klingo_cfg('klingo_api_marcar', 'teste');
  v_pct integer := coalesce(nullif(public.klingo_cfg('klingo_api_percentual', '100'), '')::integer, 100);
  ok7 bigint := public.klingo_medida_soma('horarios_api_ok', 7); er7 bigint := public.klingo_medida_soma('horarios_api_erro', 7) + public.klingo_medida_soma('horarios_api_limite', 7);
  lento7 bigint := public.klingo_medida_soma('horarios_ms_ge3s', 7); api7 bigint := public.klingo_medida_soma('sombra_api', 7); na7 bigint := public.klingo_medida_soma('sombra_api_na_grade', 7);
  ok1 bigint := public.klingo_medida_soma('horarios_api_ok', 1); er1 bigint := public.klingo_medida_soma('horarios_api_erro', 1) + public.klingo_medida_soma('horarios_api_limite', 1);
  v_dh timestamptz; v_dm timestamptz; v_dp timestamptz; v_rh timestamptz; v_rm timestamptz; suc bigint; inc bigint; tec bigint; suc24 bigint; inc24 bigint; tec24 bigint; suc_p bigint; inc_p bigint; tec_p bigint; acoes text[] := '{}';
  v_m text;
  v_tecnica constant text[] := array['plano_inativo', 'plano_desconhecido', 'sem_medico', 'nascimento_divergente', 'cadastro_divergente'];   -- falha de regra de negócio não conta como falha técnica
begin
  if public.klingo_cfg('klingo_autogestao', 'sim') <> 'sim' then return jsonb_build_object('ligada', false); end if;
  -- INTERRUPTOR GERAL (parte 10): nao/teste = a automação não anda sozinha; sim = só vigia e RECUA para "teste" se algo piorar; legado = regras antigas por chave.
  v_m := public.klingo_mestre();
  if v_m in ('nao', 'teste') then return jsonb_build_object('ligada', true, 'acoes', '[]'::jsonb, 'mestre', v_m); end if;
  if v_m = 'sim' then
    select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
           count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
      into suc24, inc24, tec24 from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '24 hours';
    select max(em) into v_rm from public.klingo_decisao where chave = 'klingo_auto' and para = 'teste';
    if (inc24 >= 2 or (tec24 >= 3 and tec24 * 5 >= suc24 + tec24 + inc24) or (er1 >= 20 and er1 * 2 >= ok1 + er1)) and (v_rm is null or v_rm < now() - interval '30 minutes') then
      perform public.klingo_decidir('klingo_auto', 'teste', jsonb_build_object('incertas_24h', inc24, 'falhas_tecnicas_24h', tec24, 'sucessos_24h', suc24, 'erros_horarios_hoje', er1),
        'O autoatendimento do Klingo voltou para "só telefones de teste": houve marcações incertas, falhas técnicas ou a agenda do Klingo falhou demais. Os pacientes seguem pelo atendimento de sempre. Confira as operações antes de ligar de novo.');
      return jsonb_build_object('ligada', true, 'acoes', jsonb_build_array('mestre:recuou'), 'mestre', 'sim');
    end if;
    return jsonb_build_object('ligada', true, 'acoes', '[]'::jsonb, 'mestre', 'sim');
  end if;
  select max(em) into v_dh from public.klingo_decisao where chave = 'klingo_api_horarios';
  select max(em) into v_dm from public.klingo_decisao where chave = 'klingo_api_marcar';
  select max(em) into v_dp from public.klingo_decisao where chave = 'klingo_api_percentual';
  -- recuo é segurança: só é segurado por OUTRO recuo recente (evita oscilar), nunca por um avanço
  select max(em) into v_rh from public.klingo_decisao where chave = 'klingo_api_horarios' and para = 'sombra';
  select max(em) into v_rm from public.klingo_decisao where chave = 'klingo_api_marcar' and para = 'teste';

  -- horários
  if v_hor = 'sim' and er1 >= 20 and er1 * 2 >= ok1 + er1 and (v_rh is null or v_rh < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_api_horarios', 'sombra', jsonb_build_object('erros_hoje', er1, 'ok_hoje', ok1), 'A agenda em tempo real do Klingo falhou em metade das consultas hoje; o chat voltou a mostrar a grade (previsão). O sistema tenta de novo sozinho.');
    acoes := array_append(acoes, 'horarios:recuou');
  elsif v_hor = 'sombra' and ok7 >= 30 and er7 * 20 <= ok7 + er7 and lento7 * 20 <= ok7 and api7 >= 200 and na7 * 100 >= api7 * 85 and (v_dh is null or v_dh < now() - interval '1 day') then
    perform public.klingo_decidir('klingo_api_horarios', 'sim', jsonb_build_object('ok_7d', ok7, 'erros_7d', er7, 'lentos_7d', lento7, 'api_7d', api7, 'api_na_grade_7d', na7), 'O chat passou a mostrar os horários reais do Klingo (a API respondeu bem por 7 dias e bate com a grade).');
    acoes := array_append(acoes, 'horarios:avancou');
  end if;

  -- marcar sozinho (operações dos últimos 30 dias, 24 h e desde a última decisão)
  select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
    into suc, inc, tec from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '30 days';
  select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
    into suc24, inc24, tec24 from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '24 hours';
  if v_mar = 'sim' and (inc24 >= 2 or (tec24 >= 3 and tec24 * 5 >= suc24 + tec24 + inc24)) and (v_rm is null or v_rm < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_api_marcar', 'teste', jsonb_build_object('incertas_24h', inc24, 'falhas_tecnicas_24h', tec24, 'sucessos_24h', suc24), 'A marcação automática foi pausada: houve marcações incertas ou falhas técnicas demais nas últimas 24 h. Só os telefones de teste continuam usando. Confira as operações antes de liberar de novo.');
    acoes := array_append(acoes, 'marcar:recuou');
    if public.klingo_cfg('klingo_api_pos', 'teste') = 'sim' then perform public.klingo_decidir('klingo_api_pos', 'teste', jsonb_build_object('motivo', 'a marcação automática recuou'), null); end if;
  elsif v_mar = 'teste' and suc >= 20 and inc = 0 and suc * 100 >= (suc + tec) * 90 and (v_dm is null or v_dm < now() - interval '1 day') then
    perform public.klingo_decidir('klingo_api_percentual', '10', jsonb_build_object('sucessos_30d', suc, 'falhas_tecnicas_30d', tec), null);
    perform public.klingo_decidir('klingo_api_marcar', 'sim', jsonb_build_object('sucessos_30d', suc, 'incertas_30d', inc, 'falhas_tecnicas_30d', tec), 'A marcação automática foi liberada para 10% das conversas (20 marcações de teste sem nenhuma incerta). O sistema aumenta sozinho se continuar bem.');
    acoes := array_append(acoes, 'marcar:avancou_10');
  elsif v_mar = 'sim' and v_pct < 100 and (v_dp is null or v_dp < now() - interval '2 days') then
    select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'), count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
      into suc_p, inc_p, tec_p from public.klingo_operacao where tipo = 'marcar' and criado_em > coalesce(v_dp, now() - interval '30 days');
    if suc_p >= 10 and inc_p = 0 and suc_p * 100 >= (suc_p + tec_p) * 95 then
      perform public.klingo_decidir('klingo_api_percentual', case when v_pct < 50 then '50' else '100' end, jsonb_build_object('sucessos', suc_p, 'falhas_tecnicas', tec_p), 'A marcação automática aumentou para ' || case when v_pct < 50 then '50%' else '100%' end || ' das conversas (taxa de sucesso alta e nenhuma incerta).');
      acoes := array_append(acoes, 'marcar:avancou_pct');
    end if;
  end if;
  if public.klingo_cfg('klingo_api_marcar', 'nao') = 'sim' and v_pct >= 100 and public.klingo_cfg('klingo_api_pos', 'teste') = 'teste' and v_dp is not null and v_dp < now() - interval '2 days'
     and not (acoes @> array['marcar:avancou_pct']) and not (acoes @> array['marcar:recuou']) then
    perform public.klingo_decidir('klingo_api_pos', 'sim', jsonb_build_object('percentual', v_pct), 'Cancelar e remarcar pelo chat foram liberados (a marcação automática já está em 100% e estável).');
    acoes := array_append(acoes, 'pos:avancou');
  end if;
  return jsonb_build_object('ligada', true, 'acoes', to_jsonb(acoes), 'horarios', v_hor, 'marcar', v_mar, 'percentual', v_pct);
end $function$;

-- Parte 11e fluxo_perguntar: nome da mãe quando a API está ligada
CREATE OR REPLACE FUNCTION public.fluxo_perguntar(p_conversa uuid, p_passo text, p_prefixo text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ctx jsonb := public.fluxo_ctx(p_conversa); c public.conversas; pa public.pre_agendamentos; d jsonb;
  v_txt text; v_op jsonb; v_hist jsonb; v_it jsonb := '[]'::jsonb; v_ult jsonb; v_pend jsonb; v_med text[]; v_nome text; v_tel text; x text; v_dig jsonb;
  v_etapa text;
begin
  select * into c from public.conversas where id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb); v_dig := coalesce(pa.paciente, '{}'::jsonb) || coalesce(d -> 'digitado', '{}'::jsonb);

  case p_passo
  when 'identidade' then
    v_txt := public.fluxo_t('identidade', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'pular', 'Prefiro não informar agora',
      'campos', jsonb_build_array(jsonb_build_object('nome', 'dt_nasc', 'rotulo', 'Data de nascimento' || (ctx ->> 'de_quem'), 'tipo', 'data', 'obrigatorio', true)));
  when 'atalho' then
    v_hist := public.paciente_historico_para_ia(p_conversa);
    v_ult := v_hist -> 'ultimas' -> 0; v_pend := v_hist -> 'pedido_pela_metade';
    v_txt := public.fluxo_t('atalho', ctx);
    if v_ult is not null and jsonb_array_length(coalesce(v_ult -> 'exames', '[]'::jsonb)) > 0 then
      select string_agg(coalesce(e ->> 'exame', e ->> 'modalidade') || coalesce(' (' || (e ->> 'lado') || ')', ''), ' + ') into x from jsonb_array_elements(v_ult -> 'exames') e;
      if coalesce((v_ult ->> 'futuro')::boolean, false) then
        v_txt := v_txt || E'\n' || format('Você já tem %s marcado para %s.', x, v_ult ->> 'quando');
      else
        v_it := v_it || jsonb_build_object('valor', 'ultimo', 'rotulo', 'Repetir o último exame', 'desc', x || ' — ' || (v_ult ->> 'quando'));
      end if;
    end if;
    if jsonb_typeof(v_pend) = 'object' and v_pend ->> 'status' <> 'pronto' then
      select string_agg(coalesce(e ->> 'exame', e ->> 'modalidade'), ' + ') into x from jsonb_array_elements(coalesce(v_pend -> 'exames', '[]'::jsonb)) e;
      v_it := v_it || jsonb_build_object('valor', 'pendente', 'rotulo', 'Continuar o pedido que ficou pela metade', 'desc', coalesce(x, ''));
    end if;
    v_it := v_it || jsonb_build_object('valor', 'outro', 'rotulo', 'Fazer outro pedido');
    v_op := public.fluxo_escolha(p_passo, v_it);
  when 'motivo' then
    v_txt := public.fluxo_t(case when (ctx ->> 'filho')::boolean then 'motivo_filho' else 'motivo_proprio' end, ctx);
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'exame', 'rotulo', 'Exame', 'desc', 'Ressonância, tomografia, ultrassom, raio-X, mamografia e outros'),
      jsonb_build_object('valor', 'consulta', 'rotulo', 'Consulta', 'desc', case when (ctx ->> 'filho')::boolean then 'Pediatria e especialidades' else 'Com médico ou especialista' end),
      jsonb_build_object('valor', 'assunto', 'rotulo', 'Outro assunto', 'desc', 'Remarcar, cancelar, resultado de exame, dúvida')));
  when 'exame' then
    v_txt := public.fluxo_t('exame', ctx);
    v_op := jsonb_build_object('tipo', 'busca_exame', 'passo', p_passo, 'termo', d ->> 'termo');
  when 'consulta' then
    v_txt := public.fluxo_t('consulta', ctx);
    v_op := jsonb_build_object('tipo', 'pedido_consulta', 'passo', p_passo);
  when 'medico' then
    v_med := public.fluxo_medicos(p_conversa);
    select coalesce(jsonb_agg(jsonb_build_object('valor', m, 'rotulo', initcap(lower(m))) order by m), '[]'::jsonb) into v_it from unnest(v_med) m;
    select lower(x2.rotulo) into x from public.pre_agendamento_itens i
      cross join lateral public.consultas_da_unidade((select u.catalogo from public.unidade_config u where u.chave = c.unidade_inicial)) x2
      where i.conversa_id = p_conversa and i.ativo and i.modalidade = 'CONSULTA' and x2.id = i.procedimento_id limit 1;
    v_txt := public.fluxo_t('medico', ctx || jsonb_build_object('consulta', coalesce(x, 'a consulta')));
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', '', 'rotulo', 'Tanto faz (qualquer médico)')) || v_it);
  when 'assunto' then
    v_txt := public.fluxo_t('assunto', ctx);
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'Remarcar', 'rotulo', 'Remarcar um horário'), jsonb_build_object('valor', 'Cancelar', 'rotulo', 'Cancelar um horário'),
      jsonb_build_object('valor', 'Resultado de exame', 'rotulo', 'Resultado de exame'), jsonb_build_object('valor', 'Dúvida', 'rotulo', 'Tirar uma dúvida'),
      jsonb_build_object('valor', 'Reclamação', 'rotulo', 'Reclamação ou sugestão'), jsonb_build_object('valor', 'Outro', 'rotulo', 'Outro assunto')));
  when 'exame_aberto', 'remarcar_falta' then
    v_op := public.fluxo_pos_pergunta(p_conversa, p_passo);
    v_txt := v_op ->> 'texto';
    v_op := v_op -> 'op';
  when 'assunto_qual', 'assunto_confirma', 'assunto_resultado', 'assunto_fim' then
    v_op := public.fluxo_assunto_pergunta(p_conversa, p_passo);
    v_txt := v_op ->> 'texto';
    v_op := v_op -> 'op';
  when 'assunto_texto' then
    v_txt := public.fluxo_t('assunto_texto', ctx);
    v_op := jsonb_build_object('tipo', 'texto', 'passo', p_passo, 'texto_livre', true, 'placeholder', 'Escreva aqui');
  when 'plano' then
    v_txt := public.fluxo_t('plano', ctx);
    select coalesce(jsonb_agg(jsonb_build_object('valor', o.operadora, 'rotulo', initcap(lower(o.operadora))) order by o.n desc, o.operadora), '[]'::jsonb) into v_it
    -- convenios-e-foto: convênio desativado pela gestão não entra na lista.
    from (select operadora, count(*) n from public.catalogo_plano where coalesce(ativo, true) and operadora !~* '^(teste|particular)$' and public.convenio_ativo(operadora) group by operadora) o;
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'Particular', 'rotulo', 'Particular (sem convênio)')) || v_it,
      jsonb_build_object('filtro', true, 'outro', jsonb_build_object('rotulo', 'Meu convênio não está na lista', 'placeholder', 'Nome do convênio')));
  when 'plano_confirma' then
    x := d ->> 'plano_anterior';
    v_txt := public.fluxo_t('plano_confirma', ctx || jsonb_build_object('como',
      case when lower(btrim(x)) = 'particular' then 'particular' else 'pelo convênio ' || initcap(lower(x)) end));
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'sim', 'rotulo', 'Sim, é o mesmo'),
                                                            jsonb_build_object('valor', 'nao', 'rotulo', 'Não, mudou')));
  when 'horario' then
    v_txt := public.fluxo_t('horario', ctx);
    if jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) > 0 then
      v_txt := public.fluxo_t('horario_proximo', jsonb_build_object('grupo', jsonb_array_length(pa.escolha_horario) + 1,
                                                                    'total', jsonb_array_length(public.agenda_grupos(public.fluxo_procs(p_conversa)))));
    end if;
    v_op := jsonb_build_object('tipo', 'calendario', 'passo', p_passo, 'grupo', jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) + 1,
      'acoes', jsonb_build_array(jsonb_build_object('valor', 'sem_horario', 'rotulo', 'Nenhum horário serve para mim')));
  when 'mudou' then
    v_txt := public.fluxo_t('mudou', ctx);
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'igual', 'rotulo', 'Não, continuam os mesmos'),
                                                            jsonb_build_object('valor', 'mudou', 'rotulo', 'Sim, algo mudou')));
  when 'cpf_nasc' then   -- klingo-auto
    v_txt := public.fluxo_t('cpf_nasc', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'cpf', 'rotulo', case when (ctx ->> 'filho')::boolean then 'CPF da criança (ou do responsável, se ela não tiver)' else 'CPF' end,
                         'tipo', 'cpf', 'obrigatorio', true, 'valor', v_dig ->> 'cpf'),
      jsonb_build_object('nome', 'dt_nasc', 'rotulo', 'Data de nascimento' || (ctx ->> 'de_quem'), 'tipo', 'data', 'obrigatorio', true, 'valor', v_dig ->> 'dt_nasc')));
  when 'dados_ident' then
    v_nome := coalesce(v_dig ->> 'nome', case when (ctx ->> 'filho')::boolean then c.paciente_nome else c.nome_informado end);
    v_txt := public.fluxo_t('dados_ident', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'nome', 'rotulo', 'Nome completo' || (ctx ->> 'de_quem'), 'tipo', 'texto', 'obrigatorio', true, 'valor', v_nome),
      jsonb_build_object('nome', 'sexo', 'rotulo', 'Sexo', 'tipo', 'sexo', 'obrigatorio', true, 'valor', v_dig ->> 'sexo'),
      jsonb_build_object('nome', 'dt_nasc', 'rotulo', 'Data de nascimento', 'tipo', 'data', 'obrigatorio', true, 'valor', v_dig ->> 'dt_nasc'),
      jsonb_build_object('nome', 'cpf', 'rotulo', case when (ctx ->> 'filho')::boolean then 'CPF da criança (ou do responsável, se ela não tiver)' else 'CPF' end,
                         'tipo', 'cpf', 'obrigatorio', true, 'valor', v_dig ->> 'cpf')))   -- klingo-auto: CPF obrigatório
      || case when public.klingo_ativo(p_conversa, 'klingo_api_marcar') then jsonb_build_object('campos', (jsonb_build_array(
           jsonb_build_object('nome', 'nome', 'rotulo', 'Nome completo' || (ctx ->> 'de_quem'), 'tipo', 'texto', 'obrigatorio', true, 'valor', v_nome),
           jsonb_build_object('nome', 'sexo', 'rotulo', 'Sexo', 'tipo', 'sexo', 'obrigatorio', true, 'valor', v_dig ->> 'sexo'),
           jsonb_build_object('nome', 'dt_nasc', 'rotulo', 'Data de nascimento', 'tipo', 'data', 'obrigatorio', true, 'valor', v_dig ->> 'dt_nasc'),
           jsonb_build_object('nome', 'cpf', 'rotulo', case when (ctx ->> 'filho')::boolean then 'CPF da criança (ou do responsável, se ela não tiver)' else 'CPF' end, 'tipo', 'cpf', 'obrigatorio', true, 'valor', v_dig ->> 'cpf'),
           jsonb_build_object('nome', 'mae', 'rotulo', 'Nome completo da mãe' || (ctx ->> 'de_quem'), 'tipo', 'texto', 'obrigatorio', true, 'valor', v_dig ->> 'mae')))) else '{}'::jsonb end;   -- klingo-auto: com a API ligada, o nome da mãe também é conferido
  when 'dados_contato' then
    select ct.telefone into v_tel from public.contatos ct where ct.id = c.contato_id;
    v_txt := public.fluxo_t('dados_contato', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'celular', 'rotulo', 'Celular (WhatsApp)', 'tipo', 'tel', 'obrigatorio', true, 'valor', coalesce(v_dig ->> 'celular', v_tel)),
      jsonb_build_object('nome', 'telefone', 'rotulo', 'Outro telefone', 'tipo', 'tel', 'obrigatorio', false, 'valor', v_dig ->> 'telefone'),
      jsonb_build_object('nome', 'email', 'rotulo', 'E-mail', 'tipo', 'email', 'obrigatorio', true,
        'valor', coalesce(v_dig ->> 'email', (select coalesce(nullif(btrim(c.email_informado), ''), ct2.email) from public.contatos ct2 where ct2.id = c.contato_id)))));
  when 'dados_endereco' then
    v_txt := public.fluxo_t('dados_endereco', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'pular', 'Não sei agora (o atendente completa)', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'cep', 'rotulo', 'CEP', 'tipo', 'cep', 'obrigatorio', false, 'valor', v_dig ->> 'cep'),
      jsonb_build_object('nome', 'endereco', 'rotulo', 'Rua', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'endereco'),
      jsonb_build_object('nome', 'numero', 'rotulo', 'Número', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'numero'),
      jsonb_build_object('nome', 'complemento', 'rotulo', 'Complemento', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'complemento'),
      jsonb_build_object('nome', 'bairro', 'rotulo', 'Bairro', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'bairro'),
      jsonb_build_object('nome', 'cidade', 'rotulo', 'Cidade', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'cidade'),
      jsonb_build_object('nome', 'uf', 'rotulo', 'UF', 'tipo', 'uf', 'obrigatorio', false, 'valor', v_dig ->> 'uf')));
  when 'dados_carteira' then
    v_txt := public.fluxo_t('dados_carteira', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'pular', 'Não estou com a carteirinha agora', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'matricula', 'rotulo', 'Número da carteirinha (' || coalesce(initcap(lower(pa.plano)), 'convênio') || ')', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'matricula'),
      jsonb_build_object('nome', 'validade', 'rotulo', 'Validade', 'tipo', 'data', 'obrigatorio', false, 'valor', v_dig ->> 'validade')));
  when 'confirmar' then
    v_txt := public.fluxo_t('confirmar', ctx || jsonb_build_object('resumo', public.fluxo_leitura(p_conversa)));
    v_it := jsonb_build_array(jsonb_build_object('valor', 'ok', 'rotulo', 'Está tudo certo'),
      jsonb_build_object('valor', 'pedido', 'rotulo', case when pa.tipo = 'consulta' then 'Corrigir a consulta' else 'Corrigir o exame' end),
      jsonb_build_object('valor', 'plano', 'rotulo', 'Corrigir o plano'));
    if jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) > 0 then v_it := v_it || jsonb_build_object('valor', 'horario', 'rotulo', 'Corrigir o horário'); end if;
    v_it := v_it || jsonb_build_object('valor', 'dados', 'rotulo', 'Corrigir os dados do cadastro');
    v_op := public.fluxo_escolha(p_passo, v_it);
  else
    return;
  end case;

  if p_prefixo is not null and btrim(p_prefixo) <> '' then v_txt := btrim(p_prefixo) || E'\n\n' || v_txt; end if;
  perform public.fluxo_dizer(p_conversa, v_txt, v_op);
  update public.conversa_fluxo set tentativas = case when passo is distinct from p_passo then 0 else tentativas end, passo = p_passo, atualizado_em = now()
  where conversa_id = p_conversa;
  v_etapa := case when p_passo in ('motivo','exame','consulta','atalho','medico') then 'pedido' when p_passo in ('plano', 'plano_confirma', 'cpf_nasc') then 'plano' when p_passo = 'horario' then 'data_hora'
                  when p_passo in ('mudou','dados_ident','dados_contato','dados_endereco','dados_carteira','identidade') then 'dados' when p_passo = 'confirmar' then 'confirmacao' end;
  if v_etapa is not null then update public.pre_agendamentos set etapa = v_etapa where conversa_id = p_conversa and status = 'rascunho'; end if;
end $function$;

-- Parte 11f fluxo_aplicar: aceita o nome da mãe
CREATE OR REPLACE FUNCTION public.fluxo_aplicar(p_conversa uuid, p_passo text, p_valor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v text := case when jsonb_typeof(p_valor) = 'string' then p_valor #>> '{}' else null end;
  o jsonb := case when jsonb_typeof(p_valor) = 'object' then p_valor else '{}'::jsonb end;
  c public.conversas; pa public.pre_agendamentos; ctx jsonb := public.fluxo_ctx(p_conversa);
  v_dt date; v_pac jsonb := '{}'::jsonb; v_err text[] := '{}'; v_ok boolean; v_med text[]; k text; x text; v_uni text;
begin
  select * into c from public.conversas where id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  case p_passo
  when 'identidade' then
    if coalesce((o ->> 'pular')::boolean, false) then perform public.fluxo_set(p_conversa, '{"identidade_feita": true}'); return '{"ok": true}'; end if;
    v_dt := public.fluxo_ler_data(o ->> 'dt_nasc');
    if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', public.fluxo_t('identidade_erro')); end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', jsonb_build_object('dt_nasc', v_dt::text)));
    perform public.fluxo_set(p_conversa, jsonb_build_object('identidade_feita', true, 'digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb) || jsonb_build_object('dt_nasc', to_char(v_dt, 'DD/MM/YYYY'))));
  when 'cpf_nasc' then   -- klingo-auto
    x := regexp_replace(coalesce(o ->> 'cpf', ''), '\D', '', 'g');
    v_dt := public.fluxo_ler_data(o ->> 'dt_nasc');
    if not public.fluxo_cpf_ok(x) then v_err := array_append(v_err, 'o CPF (os números não conferem)'::text); end if;
    if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then v_err := array_append(v_err, 'a data de nascimento'::text); end if;
    if cardinality(v_err) > 0 then return jsonb_build_object('ok', false, 'erro', public.fluxo_t('dados_erro', jsonb_build_object('erros', array_to_string(v_err, ' e ')))); end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', jsonb_build_object('cpf', x, 'dt_nasc', v_dt::text)));
    perform public.fluxo_set(p_conversa, jsonb_build_object('digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb)
                                                             || jsonb_build_object('cpf', x, 'dt_nasc', to_char(v_dt, 'DD/MM/YYYY')), 'cpf_nasc_refazer', null));
  when 'atalho' then
    if v in ('ultimo', 'pendente') then
      -- convenio-quem-volta: o convênio da vez anterior não é copiado; vira pergunta ("plano_confirma").
      x := case v when 'ultimo' then public.paciente_historico_para_ia(p_conversa) -> 'ultimas' -> 0 ->> 'plano'
                  else (select o2.plano from public.pre_agendamentos o2 where o2.conversa_id = public.pre_pendencia_anterior(p_conversa)) end;
      v_ok := public.pre_reaproveitar(p_conversa, v);
      if v_ok and nullif(btrim(coalesce(x, '')), '') is not null and public.convenio_ativo(x) then   -- convenios-e-foto: convênio desativado depois não vira pergunta
        perform public.fluxo_set(p_conversa, jsonb_build_object('plano_anterior', left(btrim(x), 120)));
      end if;
      if v_ok then perform public.fluxo_set(p_conversa, '{"motivo": "exame"}');
      else return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('atalho_falhou')); end if;
    elsif v is distinct from 'outro' then return '{"ok": false}';
    end if;
  when 'motivo' then
    if v not in ('exame', 'consulta', 'assunto') then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('motivo', v));
    if v = 'consulta' then
      select u.chave into v_uni from public.unidade_config u
       where u.ativo and u.fluxo = case when (ctx ->> 'filho')::boolean then 'pediatria' else 'exame_consulta' end order by u.ordem limit 1;
      update public.conversas set unidade_inicial = v_uni where id = p_conversa;
    elsif v = 'exame' then
      update public.conversas set unidade_inicial = null where id = p_conversa;
    end if;
  when 'medico' then
    v_med := public.fluxo_medicos(p_conversa);
    if coalesce(v, '') <> '' and not (v = any(coalesce(v_med, '{}'))) then return '{"ok": false}'; end if;
    update public.conversas set medico_preferido = nullif(v, '') where id = p_conversa;
    if coalesce(v, '') <> '' then perform public.fluxo_pre(p_conversa, jsonb_build_object('profissional', v)); end if;
    perform public.fluxo_set(p_conversa, '{"medico_feito": true}');
  when 'assunto' then
    if coalesce(v, '') = '' then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('assunto', left(v, 60)));
  when 'exame_aberto', 'remarcar_falta' then
    return public.fluxo_pos_aplicar(p_conversa, p_passo, v);
  when 'assunto_qual', 'assunto_confirma', 'assunto_resultado' then
    return public.fluxo_assunto_aplicar(p_conversa, p_passo, v);
  when 'assunto_texto' then
    x := btrim(coalesce(v, o ->> 'texto', ''));
    if x = '' then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', left(x, 500)));
    return '{"ok": true, "transferir": true}';
  when 'plano' then
    x := btrim(coalesce(v, o ->> 'outro', ''));
    -- convenios-e-foto: convênio desativado pela gestão não é aceito; a pessoa escolhe outro, Particular ou o atendente.
    if x <> '' and not public.convenio_ativo(x) then
      return jsonb_build_object('ok', false, 'erro', public.convenio_msg(x, 'inativo'));
    end if;
    if x = '' then return '{"ok": false}'; end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('plano', left(x, 120), 'etapa', 'plano'));
    perform public.fluxo_set(p_conversa, '{"plano_anterior": null}');
    perform public.convenio_avisar(p_conversa, x);   -- convenios-e-foto: aviso e regra "um exame por vez"
    -- convenio-quem-volta: corrigiu o plano na confirmação e escolheu OUTRO convênio: a carteirinha antiga não vale mais.
    select dados ->> 'plano_trocado_de' into k from public.conversa_fluxo where conversa_id = p_conversa;
    if k is not null then
      perform public.fluxo_set(p_conversa, '{"plano_trocado_de": null}');
      if lower(btrim(k)) is distinct from lower(btrim(left(x, 120))) then
        perform public.fluxo_set(p_conversa, jsonb_build_object('g_carteira', false, 'confirmado', false,
          'digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb) - 'matricula' - 'validade'));
        if jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) > 0 then
          perform public.fluxo_nota(p_conversa, 'Convênio trocado de ' || k || ' para ' || left(x, 120) || ' depois de escolher o horário: conferir se o médico/unidade atende o convênio novo');
          if o ->> 'outro' is null then return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('plano_trocado_horario')); end if;
        elsif o ->> 'outro' is null then
          return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('plano_trocado'));
        end if;
      end if;
    end if;
    if o ->> 'outro' is not null then
      perform public.fluxo_nota(p_conversa, 'Convênio digitado pelo paciente (fora da lista): ' || x);
      perform public.fluxo_set(p_conversa, '{"confirmado": false}');
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('plano_outro', jsonb_build_object('plano', left(x, 120))));
    end if;
  when 'plano_confirma' then
    select dados ->> 'plano_anterior' into x from public.conversa_fluxo where conversa_id = p_conversa;
    if v = 'sim' then
      if x is not null then perform public.fluxo_pre(p_conversa, jsonb_build_object('plano', x, 'etapa', 'plano')); end if;
      perform public.fluxo_set(p_conversa, '{"plano_anterior": null}');
    elsif v = 'nao' then
      perform public.fluxo_set(p_conversa, '{"plano_anterior": null}');
    else return '{"ok": false}'; end if;
  when 'horario' then
    if v = 'sem_horario' then
      perform public.fluxo_set(p_conversa, '{"sem_horario": true}');
      perform public.fluxo_nota(p_conversa, 'Nenhum horário do calendário serviu: procurar outro com o paciente');
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('horario_nenhum'));
    end if;
    return '{"ok": false}';
  when 'mudou' then
    if v = 'igual' then perform public.fluxo_set(p_conversa, '{"mudou": "igual", "g_ident": true, "g_contato": true, "g_endereco": true}');
    elsif v = 'mudou' then perform public.fluxo_set(p_conversa, '{"mudou": "mudou"}');
    else return '{"ok": false}'; end if;
  when 'dados_ident', 'dados_contato', 'dados_endereco', 'dados_carteira' then
    if coalesce((o ->> 'pular')::boolean, false) and p_passo in ('dados_endereco', 'dados_carteira') then
      perform public.fluxo_set(p_conversa, jsonb_build_object(case p_passo when 'dados_endereco' then 'g_endereco' else 'g_carteira' end, true));
      perform public.fluxo_nota(p_conversa, case p_passo when 'dados_endereco' then 'Endereço não informado' else 'Carteirinha não informada' end);
      return '{"ok": true}';
    end if;
    foreach k in array case p_passo
        when 'dados_ident' then array['nome','sexo','dt_nasc','cpf','mae']
        when 'dados_contato' then array['celular','telefone','email']
        when 'dados_endereco' then array['cep','endereco','numero','complemento','bairro','cidade','uf']
        else array['matricula','validade'] end loop
      x := nullif(btrim(coalesce(o ->> k, '')), '');
      if x is null then continue; end if;
      if k in ('dt_nasc', 'validade') then
        v_dt := public.fluxo_ler_data(x);
        if v_dt is null or (k = 'dt_nasc' and (v_dt > current_date or v_dt < date '1900-01-01')) then
          v_err := array_append(v_err, case k when 'dt_nasc' then 'a data de nascimento' else 'a validade' end); continue;
        end if;
        x := v_dt::text;
      elsif k = 'cpf' then
        if not public.fluxo_cpf_ok(x) then v_err := array_append(v_err, 'o CPF (os números não conferem)'::text); continue; end if;
      elsif k = 'email' then
        x := lower(x);
        if x !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_err := array_append(v_err, 'o e-mail'::text); continue; end if;
      elsif k in ('celular', 'telefone') then
        x := regexp_replace(x, '\D', '', 'g');
        if length(x) not in (10, 11) then v_err := array_append(v_err, case k when 'celular' then 'o celular (DDD + número)' else 'o outro telefone' end); continue; end if;
      elsif k = 'cep' then
        x := regexp_replace(x, '\D', '', 'g');
        if length(x) <> 8 then v_err := array_append(v_err, 'o CEP (8 números)'::text); continue; end if;
      elsif k = 'sexo' then
        x := upper(left(x, 1));
        if x not in ('M', 'F') then v_err := array_append(v_err, 'o sexo'::text); continue; end if;
      elsif k = 'uf' then
        x := upper(left(x, 2));
      elsif k in ('nome', 'mae') and length(x) < 5 then
        v_err := array_append(v_err, case k when 'mae' then 'o nome da mãe' else 'o nome completo' end); continue;
      end if;
      v_pac := v_pac || jsonb_build_object(k, left(x, 200));
    end loop;
    if p_passo = 'dados_ident' then
      if v_pac ->> 'nome' is null and not ('o nome completo' = any(v_err)) then v_err := array_append(v_err, 'o nome completo'::text); end if;
      if v_pac ->> 'sexo' is null and not ('o sexo' = any(v_err)) then v_err := array_append(v_err, 'o sexo'::text); end if;
      if v_pac ->> 'dt_nasc' is null and not ('a data de nascimento' = any(v_err)) then v_err := array_append(v_err, 'a data de nascimento'::text); end if;
      if v_pac ->> 'cpf' is null and not ('o CPF (os números não conferem)' = any(v_err)) then v_err := array_append(v_err, 'o CPF'::text); end if;
    elsif p_passo = 'dados_contato' and v_pac ->> 'celular' is null and not ('o celular (DDD + número)' = any(v_err)) then
      v_err := array_append(v_err, 'o celular (DDD + número)'::text);
    end if;
    if cardinality(v_err) > 0 then
      return jsonb_build_object('ok', false, 'erro', public.fluxo_t('dados_erro', jsonb_build_object('erros', array_to_string(v_err, ', '))));
    end if;
    if v_pac <> '{}'::jsonb then perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', v_pac, 'etapa', 'dados')); end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object(case p_passo when 'dados_ident' then 'g_ident' when 'dados_contato' then 'g_contato'
                                                             when 'dados_endereco' then 'g_endereco' else 'g_carteira' end, true,
      'digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb) || (o - 'pular')));
  when 'confirmar' then
    if v = 'ok' then perform public.fluxo_set(p_conversa, '{"confirmado": true}');
    elsif v = 'pedido' then perform public.fluxo_set(p_conversa, '{"refazer": "pedido", "confirmado": false}');
    elsif v = 'plano' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('plano_trocado_de', pa.plano, 'plano_anterior', null, 'confirmado', false));
      update public.pre_agendamentos set plano = null where conversa_id = p_conversa;
    elsif v = 'horario' then
      update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null where conversa_id = p_conversa;
      perform public.fluxo_set(p_conversa, '{"confirmado": false, "sem_horario": false}');
    elsif v = 'dados' then perform public.fluxo_set(p_conversa, '{"confirmado": false, "mudou": "mudou", "g_ident": false, "g_contato": false, "g_endereco": false, "g_carteira": false}');
    else return '{"ok": false}'; end if;
  else
    return '{"ok": false}';
  end case;
  return '{"ok": true}';
end $function$;

-- Parte 11g texto novo
insert into public.fluxo_texto (chave, texto) values
  ('divergencia_clinica', 'Para a sua segurança, não consegui confirmar seus dados com o cadastro da clínica. Venha até a CSI com um documento com foto para fazer o agendamento e atualizar o seu cadastro. Se tiver alguma dúvida, a nossa equipe também pode te ajudar por aqui.')
on conflict (chave) do nothing;
