-- Autoatendimento com a API do Klingo — Parte 4a: ofertas, operações de marcação e o que o motor decide. Escrito em 12/11/2026.
--
-- FLUXOGRAMA: o paciente confirma o pedido (fluxo_finalizar) -> klingo_pode_marcar decide SE a automação vale para esta conversa (interruptor, 1 procedimento, horário oferecido pela API
--   e ainda válido, convênio traduzido, CPF + nascimento, paciente conferido ou novo) -> klingo_operacao_criar grava a operação (chave única = duplo toque vira 1 só) e chama klingo-executar
--   (pg_net, só com o id da operação) -> klingo-executar confere a identidade, reserva, marca e devolve o resultado -> klingo_operacao_concluir:
--   sucesso = pedido "agendado" (origem chat_api) + cartão do voucher; horário tomado = volta à escolha do horário; falha ou incerto = equipe, com a nota do motivo.
--   klingo_operacao_vigiar (rotina de 1 min) refaz chamada perdida, marca como INCERTO o que ficou preso e encerra a conversa já resolvida.
-- Versão 1.0 — 12/11/2026 / Mudança: primeira versão.
-- Regra de segurança central: klingo-executar recebe SÓ o id da operação; CPF, nascimento, horário, procedimento e plano são lidos do banco, onde já foram validados.
-- Para voltar atrás: update public.config set valor = 'nao' where chave in ('klingo_api_marcar','klingo_api_pre_cadastro','klingo_api_pos'); (o passo "confirmar" volta a gerar pedido para a equipe).

-- Textos do chat (editáveis em Configurações)
insert into public.fluxo_texto (chave, texto) values
  ('cpf_nasc', 'Para localizar o seu cadastro na clínica e agilizar o seu atendimento, preciso do CPF e da data de nascimento{de_quem}. Eles ficam protegidos e só servem para conferir quem é o paciente.'),
  ('marcando', 'Perfeito! Estou reservando o seu horário no sistema da clínica. Leva só alguns segundos…'),
  ('marcado', 'Pronto, {nome}! Seu agendamento está confirmado no sistema da clínica. ✅'),
  ('marcado_aguarde', 'Ainda estou finalizando a sua marcação, só mais um instante.'),
  ('marcar_ocupado', 'Esse horário acabou de ser ocupado por outra pessoa. Vamos escolher outro? Nada foi cobrado nem ficou reservado em seu nome.'),
  ('marcar_equipe', 'Não consegui concluir o agendamento sozinho, mas já passei tudo para a nossa equipe e uma pessoa confirma com você em instantes.'),
  ('marcar_incerto', 'O sistema da clínica demorou a responder. Já pedi para a equipe conferir a sua marcação, então você não precisa repetir nada.'),
  ('marcar_plano', 'Não consegui agendar pelo convênio {plano} agora. Já passei para a equipe, que resolve com você e confirma o horário.')
on conflict (chave) do nothing;

-- Substitui as ofertas da conversa (o servidor lembra o que ofereceu; o chat só escolhe entre estes horários).
-- p_ofertas = [{chave, data, hora, profissional, profissional_id, unidade, unidade_id, ordem_chegada}]
create or replace function public.klingo_oferta_gravar(p_conversa uuid, p_procedimento integer, p_plano integer, p_ofertas jsonb) returns integer
language plpgsql security definer set search_path to '' as $$
declare v_n integer;
begin
  delete from public.klingo_oferta where conversa_id = p_conversa;
  insert into public.klingo_oferta (conversa_id, chave, procedimento, plano, data, hora, profissional, profissional_id, unidade, unidade_id, ordem_chegada, expira_em)
  select p_conversa, left(o ->> 'chave', 120), p_procedimento, p_plano, (o ->> 'data')::date, left(o ->> 'hora', 5), left(o ->> 'profissional', 120), left(o ->> 'profissional_id', 20),
         left(o ->> 'unidade', 120), left(o ->> 'unidade_id', 20), coalesce((o ->> 'ordem_chegada')::boolean, false), now() + interval '30 minutes'
    from jsonb_array_elements(case when jsonb_typeof(p_ofertas) = 'array' then p_ofertas else '[]'::jsonb end) o
   where (o ->> 'data') ~ '^\d{4}-\d{2}-\d{2}$' and (o ->> 'hora') ~ '^\d{2}:\d{2}' and nullif(o ->> 'chave', '') is not null
  on conflict (conversa_id, chave) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Os nomes do médico na grade e na API se parecem? (tira Dr/Dra, compara os pedaços do nome: um contido no outro, com pelo menos 2 pedaços)
create or replace function public.klingo_prof_confere(a text, b text) returns boolean
language sql immutable set search_path to '' as $$
  with t as (
    select array(select x from unnest(string_to_array(coalesce(public.norm_nome(a), ''), ' ')) x where x <> '' and x not in ('DR', 'DRA', 'DOUTOR', 'DOUTORA')) as ta,
           array(select x from unnest(string_to_array(coalesce(public.norm_nome(b), ''), ' ')) x where x <> '' and x not in ('DR', 'DRA', 'DOUTOR', 'DOUTORA')) as tb)
  select cardinality(ta) >= 2 and cardinality(tb) >= 2 and (ta <@ tb or tb <@ ta) from t
$$;

-- A API vale para este pedido? Devolve {ok, motivo}. Só olha o que o banco já sabe (a Edge Function ainda confere tudo de novo antes de marcar).
create or replace function public.klingo_pode_marcar(p_conversa uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare pa public.pre_agendamentos; d jsonb; e jsonb; o public.klingo_oferta; v_id jsonb; v_pl jsonb; v_novo boolean := false;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if not public.klingo_ativo(p_conversa, 'klingo_api_marcar') then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  if pa.status = 'agendado' or pa.id is null then return jsonb_build_object('ok', false, 'motivo', 'ja_agendado'); end if;
  d := public.klingo_dados_conversa(p_conversa);
  if (d ->> 'n_procedimentos')::int <> 1 then return jsonb_build_object('ok', false, 'motivo', 'varios_procedimentos'); end if;
  if jsonb_typeof(pa.escolha_horario) <> 'array' or jsonb_array_length(pa.escolha_horario) <> 1 then return jsonb_build_object('ok', false, 'motivo', 'horario_nao_unico'); end if;
  e := pa.escolha_horario -> 0;
  select * into o from public.klingo_oferta where conversa_id = p_conversa and chave = e ->> 'klingo_chave' and expira_em > now() - interval '20 minutes';
  if o.id is null then return jsonb_build_object('ok', false, 'motivo', 'sem_oferta_da_api'); end if;
  if o.procedimento is distinct from (d ->> 'procedimento')::int then return jsonb_build_object('ok', false, 'motivo', 'oferta_de_outro_procedimento'); end if;
  if d ->> 'cpf' is null or d ->> 'nascimento' is null or d ->> 'nome' is null or d ->> 'sexo' is null then return jsonb_build_object('ok', false, 'motivo', 'dados_incompletos'); end if;
  v_id := d -> 'identidade';
  if v_id is not null and jsonb_typeof(v_id) = 'object' then
    if v_id ->> 'situacao' in ('divergente', 'sem_id_definitivo') then return jsonb_build_object('ok', false, 'motivo', 'cadastro_divergente'); end if;
    if v_id ->> 'situacao' = 'nao_encontrado' then v_novo := true; end if;
  end if;
  if v_novo and not public.klingo_ativo(p_conversa, 'klingo_api_pre_cadastro') then return jsonb_build_object('ok', false, 'motivo', 'paciente_novo'); end if;
  v_pl := public.klingo_plano_resolver(pa.plano, nullif(v_id ->> 'plano_id', '')::int);
  if (v_pl ->> 'plano_id') is null and not (v_id is null or v_id ->> 'situacao' is null) then return jsonb_build_object('ok', false, 'motivo', coalesce(v_pl ->> 'motivo', 'sem_plano')); end if;
  if (v_pl ->> 'plano_id') is not null and (v_pl ->> 'plano_id')::int is distinct from o.plano and (v_pl ->> 'via') = 'padrao' and o.plano <> (v_pl ->> 'plano_id')::int and v_id is not null then
    return jsonb_build_object('ok', false, 'motivo', 'plano_mudou_depois_da_oferta');
  end if;
  -- exame só pelo Particular até a regra de autorização/preparo por convênio existir (decisão registrada em docs/klingo-autoatendimento.md)
  if pa.tipo = 'exame' and public.norm_nome(pa.plano) <> 'PARTICULAR' and public.klingo_cfg('klingo_api_exame_convenio', 'nao') <> 'sim' then
    return jsonb_build_object('ok', false, 'motivo', 'exame_com_convenio');
  end if;
  return jsonb_build_object('ok', true, 'novo', v_novo);
end $$;

-- Cria a operação (idempotente) e chama o executor.
create or replace function public.klingo_operacao_disparar(p_op uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo();
begin
  if v_base = '' or v_seg is null then return; end if;
  perform net.http_post(url := v_base || 'klingo-executar', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg),
    body := jsonb_build_object('operacao_id', p_op), timeout_milliseconds := 60000);
exception when others then null;
end $$;

create or replace function public.klingo_operacao_criar(p_conversa uuid) returns uuid
language plpgsql security definer set search_path to '' as $$
declare pa public.pre_agendamentos; e jsonb; o public.klingo_oferta; v_chave text; v_op uuid;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  e := pa.escolha_horario -> 0;
  select * into o from public.klingo_oferta where conversa_id = p_conversa and chave = e ->> 'klingo_chave';
  v_chave := 'marcar:' || pa.id::text || ':' || (e ->> 'klingo_chave');
  insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, detalhe)
  values (p_conversa, pa.id, 'marcar', v_chave, jsonb_build_object('chave', e ->> 'klingo_chave', 'data', e ->> 'data', 'hora', e ->> 'hora', 'procedimento', o.procedimento, 'plano', o.plano))
  on conflict (chave_idem) do nothing returning id into v_op;
  if v_op is null then select id into v_op from public.klingo_operacao where chave_idem = v_chave; return v_op; end if;   -- duplo toque: a mesma operação, sem nova chamada
  perform public.klingo_operacao_disparar(v_op);
  perform public.klingo_medir('op_criada');
  return v_op;
end $$;

-- O executor pega a operação (só quem consegue passar de "pendente" para "executando" executa) e recebe tudo que precisa.
create or replace function public.klingo_operacao_pegar(p_op uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare op public.klingo_operacao; d jsonb; o public.klingo_oferta;
begin
  update public.klingo_operacao set estado = 'executando', iniciado_em = now(), tentativas = tentativas + 1 where id = p_op and estado = 'pendente' returning * into op;
  if op.id is null then return jsonb_build_object('ok', false, 'motivo', 'nao_pendente'); end if;
  d := public.klingo_dados_conversa(op.conversa_id);
  select * into o from public.klingo_oferta where conversa_id = op.conversa_id and chave = op.detalhe ->> 'chave';
  return jsonb_build_object('ok', true, 'operacao', jsonb_build_object('id', op.id, 'tipo', op.tipo, 'conversa_id', op.conversa_id, 'pre_agendamento_id', op.pre_agendamento_id, 'detalhe', op.detalhe, 'tentativas', op.tentativas),
    'dados', d, 'oferta', case when o.id is null then null else jsonb_build_object('chave', o.chave, 'procedimento', o.procedimento, 'plano', o.plano, 'data', o.data, 'hora', o.hora, 'profissional', o.profissional, 'unidade', o.unidade, 'unidade_id', o.unidade_id) end);
end $$;

-- A equipe recebe o pedido como sempre (corpo antigo de fluxo_finalizar), agora com a nota do motivo da automação não ter fechado.
create or replace function public.fluxo_finalizar_humano(p_conversa uuid, p_nota text default null, p_urgencia text default 'baixa', p_texto_chave text default null) returns void
language plpgsql security definer set search_path to '' as $$
declare ctx jsonb := public.fluxo_ctx(p_conversa); v_on boolean := public.fluxo_equipe_online(); v_txt text; c public.conversas;
begin
  select * into c from public.conversas where id = p_conversa;
  ctx := ctx || jsonb_build_object('plano', coalesce((select pa.plano from public.pre_agendamentos pa where pa.conversa_id = p_conversa), ''));
  if p_nota is not null then perform public.fluxo_nota(p_conversa, p_nota); end if;
  perform public.fluxo_pre(p_conversa, '{"etapa": "pronto"}'::jsonb, true);
  update public.conversa_fluxo set passo = 'pronto', dados = dados || jsonb_build_object('enviado_em', now()), atualizado_em = now() where conversa_id = p_conversa;
  v_txt := public.fluxo_t(coalesce(p_texto_chave, case when v_on then 'pronto_online' else 'pronto_offline' end), ctx);
  if jsonb_array_length(coalesce(c.irmaos, '[]'::jsonb)) > 0 then v_txt := v_txt || E'\n\n' || public.fluxo_t('irmao_proximo', ctx); end if;
  perform public.fluxo_dizer(p_conversa, v_txt, jsonb_build_object('tipo', 'acompanhar'));
  perform public.fluxo_transferir(p_conversa, 'Pré-agendamento pronto (confirmado pelo paciente).', p_urgencia, false);
end $$;

-- Resultado da operação (chamado só pelo klingo-executar). p_r = {voucher:{id,status,data,hora,procedimento,unidade,profissional}, http_status, caminho, codigo, identidade:{...}}
create or replace function public.klingo_operacao_concluir(p_op uuid, p_estado text, p_r jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  op public.klingo_operacao; pa public.pre_agendamentos; v jsonb := coalesce(p_r -> 'voucher', '{}'::jsonb); v_est text := p_estado; ctx jsonb; v_txt text; v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  v_data date; v_cod text := left(p_r ->> 'codigo', 60); v_plano text;
begin
  if v_est not in ('sucesso', 'falha', 'incerto', 'horario_tomado') then v_est := 'falha'; end if;
  select * into op from public.klingo_operacao where id = p_op for update;
  if op.id is null then return jsonb_build_object('ok', false, 'motivo', 'inexistente'); end if;
  if op.estado in ('sucesso', 'cancelada') then return jsonb_build_object('ok', true, 'repetido', true); end if;
  select * into pa from public.pre_agendamentos where id = op.pre_agendamento_id;
  ctx := public.fluxo_ctx(op.conversa_id);
  update public.klingo_operacao set estado = v_est, voucher_id = left(v ->> 'id', 30), http_status = nullif(p_r ->> 'http_status', '')::int, caminho = left(p_r ->> 'caminho', 80), codigo = v_cod, concluido_em = now() where id = p_op;
  perform public.klingo_medir('op_' || v_est, 1, extract(milliseconds from now() - op.iniciado_em)::bigint);

  if v_est = 'sucesso' and nullif(v ->> 'id', '') is not null then
    v_data := (v ->> 'data')::date;
    update public.pre_agendamentos set status = 'agendado', agendado_origem = 'chat_api', agendado_auto_em = now(), klingo_marcacoes = array[v ->> 'id'], conferencia_status = 'confirmado', conferencia_detalhe = null,
           conferencia_em = now(), conferencia_falhas = 0, confirmacao_enviada_em = coalesce(confirmacao_enviada_em, now()), etapa = 'pronto',
           escolha_horario_chat = coalesce(escolha_horario_chat, escolha_horario),
           escolha_horario = jsonb_build_array(jsonb_build_object('grupo', 1, 'data', v ->> 'data', 'hora', v ->> 'hora', 'min', 30, 'chegada', false, 'unidade', nullif(v ->> 'unidade', ''),
                             'profissional', nullif(v ->> 'profissional', ''), 'procedimento', nullif(v ->> 'procedimento', ''), 'origem', 'klingo_api', 'klingo_chave', op.detalhe ->> 'chave')),
           atualizado_em = now()
     where id = pa.id;
    update public.conversa_fluxo set passo = 'marcado', dados = dados || jsonb_build_object('marcado_em', now(), 'operacao', p_op), atualizado_em = now() where conversa_id = op.conversa_id;
    v_txt := public.fluxo_t('marcado', ctx) || E'\n\n' || coalesce(nullif(v ->> 'procedimento', ''), 'Atendimento') || E'\n'
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
    update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null, atualizado_em = now() where id = pa.id and status not in ('agendado', 'cancelado');
    update public.conversa_fluxo set dados = dados || '{"confirmado": false, "sem_horario": false}'::jsonb, atualizado_em = now() where conversa_id = op.conversa_id;
    perform public.fluxo_perguntar(op.conversa_id, 'horario', public.fluxo_t('marcar_ocupado', ctx));
    return jsonb_build_object('ok', true, 'estado', 'horario_tomado');
  end if;

  -- falha ou incerto: a equipe assume, com o motivo
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

-- Rotina de 1 minuto: refaz chamada perdida, marca como INCERTO o que ficou preso e encerra a conversa já resolvida.
create or replace function public.klingo_operacao_vigiar() returns jsonb
language plpgsql security definer set search_path to '' as $$
declare r record; v_re integer := 0; v_inc integer := 0; v_enc integer := 0;
begin
  for r in select id from public.klingo_operacao where estado = 'pendente' and criado_em < now() - interval '45 seconds' and tentativas < 3 loop
    perform public.klingo_operacao_disparar(r.id); v_re := v_re + 1;
  end loop;
  for r in select id from public.klingo_operacao
            where (estado = 'executando' and iniciado_em < now() - interval '3 minutes') or (estado = 'pendente' and (tentativas >= 3 or criado_em < now() - interval '4 minutes')) loop
    update public.klingo_operacao set estado = 'executando' where id = r.id and estado = 'pendente';
    perform public.klingo_operacao_concluir(r.id, 'incerto', jsonb_build_object('codigo', 'sem_resposta_do_executor'));
    v_inc := v_inc + 1;
  end loop;
  -- conversa resolvida pela automação e parada há 2 h: encerra (motivo agendado, origem sistema)
  for r in select c.id from public.conversas c join public.pre_agendamentos pa on pa.conversa_id = c.id
            where c.status <> 'encerrada' and pa.agendado_origem = 'chat_api' and pa.agendado_auto_em < now() - interval '2 hours'
              and coalesce((select max(m.criado_em) from public.mensagens m where m.conversa_id = c.id and m.autor = 'cliente'), pa.agendado_auto_em) < now() - interval '2 hours'
              and c.primeiro_humano_em is null and c.ia_ativa loop
    begin
      update public.conversas set status = 'encerrada', encerrada_em = now(), motivo_encerramento = 'agendado', encerramento_origem = 'sistema' where id = r.id;
      v_enc := v_enc + 1;
    exception when others then null;
    end;
  end loop;
  return jsonb_build_object('redisparadas', v_re, 'incertas', v_inc, 'encerradas', v_enc);
end $$;

do $$ declare f text; begin
  for f in select unnest(array['klingo_oferta_gravar(uuid, integer, integer, jsonb)', 'klingo_prof_confere(text, text)', 'klingo_pode_marcar(uuid)', 'klingo_operacao_disparar(uuid)', 'klingo_operacao_criar(uuid)',
      'klingo_operacao_pegar(uuid)', 'fluxo_finalizar_humano(uuid, text, text, text)', 'klingo_operacao_concluir(uuid, text, jsonb)', 'klingo_operacao_vigiar()']) loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
