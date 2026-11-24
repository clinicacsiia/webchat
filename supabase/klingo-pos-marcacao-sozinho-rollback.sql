-- Rollback de klingo-pos-marcacao-sozinho.sql: volta as 3 funções ao retrato de 14/11/2026

-- fluxo_avancar
CREATE OR REPLACE FUNCTION public.fluxo_avancar(p_conversa uuid, p_entrada jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.conversas; f public.conversa_fluxo; v_t0 timestamptz := clock_timestamp();
  v_passo text; v_valor jsonb := p_entrada -> 'valor'; v_texto text := btrim(coalesce(p_entrada ->> 'texto', ''));
  v_norm text; v_res jsonb; v_prox text; v_prefixo text; v_tipo text := 'texto'; v_entendeu boolean := true; ctx jsonb;
begin
  select * into c from public.conversas where id = p_conversa for update;
  if not found or c.motor <> 'fluxo' or not (c.ia_ativa and c.status = 'aguardando') then return; end if;
  insert into public.conversa_fluxo (conversa_id) values (p_conversa) on conflict (conversa_id) do nothing;
  select * into f from public.conversa_fluxo where conversa_id = p_conversa for update;
  v_passo := f.passo;
  ctx := public.fluxo_ctx(p_conversa);

  if v_passo is null then
    v_prefixo := public.fluxo_t(case when (ctx ->> 'filho')::boolean then 'ola_filho' else 'ola_proprio' end, ctx);
    v_tipo := 'inicio';
  elsif v_passo in ('pronto', 'humano', 'assunto_fim') then
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('reaberta', ctx), jsonb_build_object('tipo', 'nova'));
    perform public.fluxo_transferir(p_conversa, 'Paciente voltou a escrever depois do atendimento.', 'baixa', false);
    insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'reaberta', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
    return;
  elsif p_entrada ->> 'acao' = 'atendente' then
    perform public.fluxo_transferir(p_conversa, 'Paciente pediu para falar com um atendente.', 'media', true);
    insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'atendente', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
    return;
  elsif p_entrada ->> 'evento' = 'anexo' then
    return;
  elsif v_valor is not null then
    v_tipo := 'botao';
    if p_entrada ->> 'passo' is distinct from v_passo then return; end if;
  elsif v_texto ~ '^(Pedido de exames:|Pedido de consulta:)' then
    v_tipo := 'componente';
    perform public.fluxo_set(p_conversa, jsonb_build_object('motivo', case when v_texto like 'Pedido de consulta:%' then 'consulta' else 'exame' end,
                                                            'confirmado', false, 'refazer', null, 'medico_feito', false));
    update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null
     where conversa_id = p_conversa and escolha_horario is not null and status = 'rascunho';   -- convenio-quem-volta: exame ou consulta
  elsif v_texto ~ '^(Horário \d+ de \d+: )?Escolhi ' then
    v_tipo := 'componente';
    perform public.fluxo_set(p_conversa, '{"confirmado": false}');
  elsif v_texto like 'Agora vamos agendar para %' then
    v_tipo := 'componente';
  else
    v_norm := public.fluxo_norm(v_texto);
    if v_norm ~ '(dor (muito )?(forte |intensa )?no peito|aperto no peito|falta de ar|nao consigo respirar|dificuldade (para|pra) respirar|desmai|sangramento (intenso|forte|muito)|sangrando muito|\mavc\M|derrame|boca torta|convuls|reacao alergica|anafila|garganta fechando|quero morrer|me matar|suicid|me machucar|tirar (a )?minha vida|febre (alta|muito alta)|desidrat|sangue nas fezes|sangue no vomito|vomitando sangue|inconsciente|nao acorda|engasgad|nao (esta|ta) respirando)' then
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('emergencia', ctx));
      perform public.fluxo_transferir(p_conversa, 'URGENTE: possível emergência descrita pelo paciente: "' || left(v_texto, 200) || '"', 'alta', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'emergencia', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    if v_norm ~ '(\matendente\M|\mhumano\M|recepcionista|secretaria|falar com (alguem|uma pessoa|pessoa|a clinica|voces)|pessoa de verdade|\mpessoa real\M)' then
      perform public.fluxo_transferir(p_conversa, 'Paciente pediu para falar com um atendente.', 'media', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'atendente', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    -- klingo-auto: texto livre enquanto a marcação roda ou depois dela
    if v_passo in ('marcando', 'marc_consultando') then
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('marcado_aguarde', ctx));
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'texto', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    elsif v_passo in ('marcado', 'pos_menu', 'pos_cancelar') then
      perform public.fluxo_pos_menu(p_conversa, public.fluxo_t('pos_menu_texto', ctx));
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'texto', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    if v_passo is distinct from 'assunto_texto' then
      if v_norm ~ '(quanto custa|quanto (e|fica|sai)|qual (o )?valor|\mvalor\M|\mpreco|\mcusta\M|orcamento)' then
        v_prefixo := coalesce(public.preco_previsao_chat(p_conversa), public.fluxo_t('preco', ctx)); v_prox := v_passo;
      elsif v_norm ~ '(diagnostic|remedio|medicament|posso tomar|o que (pode ser|eu tenho|ele tem|ela tem)|e grave|tratamento|dosagem|\mdose\M)' then
        v_prefixo := public.fluxo_t('clinico', ctx); v_prox := v_passo;
      end if;
    end if;
    if v_prox is null then
      v_valor := public.fluxo_ler_texto(p_conversa, v_passo, v_texto);
      if v_valor is null and v_passo = 'exame' then
        perform public.fluxo_set(p_conversa, jsonb_build_object('termo', left(v_texto, 80)));
        v_prefixo := 'Veja se o seu exame está nesta lista:'; v_prox := v_passo;
      elsif v_valor is null then
        v_entendeu := false;
        perform public.fluxo_nota(p_conversa, 'Paciente escreveu (não entendido no passo ' || coalesce(v_passo, '-') || '): ' || left(v_texto, 200));
        update public.conversa_fluxo set tentativas = tentativas + 1 where conversa_id = p_conversa;
        if (select tentativas from public.conversa_fluxo where conversa_id = p_conversa) >= coalesce(nullif(public.klingo_cfg('fluxo_max_nao_entendi', '3'), '')::integer, 3) then   -- v2.1: não deixa o paciente preso
          perform public.fluxo_dizer(p_conversa, public.fluxo_t('nao_entendi_equipe', ctx), jsonb_build_object('tipo', 'acompanhar'));
          perform public.fluxo_transferir(p_conversa, 'Paciente não conseguiu responder à pergunta (passo ' || coalesce(v_passo, '-') || ') depois de várias tentativas.', 'baixa', true);
          insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'nao_entendido_repetido', false, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
          return;
        end if;
        v_prefixo := public.fluxo_t('nao_entendi', ctx); v_prox := v_passo;
      end if;
    end if;
  end if;

  if v_valor is not null and v_prox is null then
    if v_passo in ('pos_menu', 'pos_cancelar') then   -- klingo-auto: menu depois da marcação
      perform public.fluxo_pos_responder(p_conversa, case when jsonb_typeof(v_valor) = 'string' then v_valor #>> '{}' end);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'botao', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    v_res := public.fluxo_aplicar(p_conversa, v_passo, v_valor);
    if not coalesce((v_res ->> 'ok')::boolean, false) then
      v_entendeu := false;
      v_prefixo := coalesce(v_res ->> 'erro', public.fluxo_t('nao_entendi', ctx)); v_prox := v_passo;
    elsif coalesce((v_res ->> 'transferir')::boolean, false) then
      perform public.fluxo_transferir(p_conversa, 'Outro assunto: ' || coalesce((select dados ->> 'assunto' from public.conversa_fluxo where conversa_id = p_conversa), ''), 'baixa', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, v_tipo, true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    else
      v_prefixo := v_res ->> 'aviso';
    end if;
  end if;

  if v_prox is null then v_prox := public.fluxo_proximo(p_conversa); end if;
  if v_tipo = 'inicio' and v_prox = 'cpf_nasc' then   -- cpf-primeiro: a 1ª mensagem já pede CPF e nascimento
    v_prefixo := public.fluxo_t(case when (ctx ->> 'filho')::boolean then 'ola_cpf_filho' else 'ola_cpf_proprio' end, ctx);
  end if;
  if v_prox = 'pronto' then
    perform public.fluxo_finalizar(p_conversa);
  elsif v_prox = 'horario' and v_tipo = 'componente' and v_passo = 'horario' then
    perform public.fluxo_perguntar(p_conversa, v_prox, null);
  else
    perform public.fluxo_perguntar(p_conversa, v_prox, v_prefixo);
  end if;
  insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente)
  values (p_conversa, coalesce(v_passo, 'inicio'), v_tipo, v_entendeu, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
end $function$;

-- fluxo_pos_responder
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
    if not (public.klingo_ativo(p_conversa, case when p_valor = 'cancelar' then 'klingo_api_cancelar' else 'klingo_api_remarcar' end) and pa.agendado_origem = 'chat_api' and pa.status = 'agendado' and v_vou ~ '^[0-9]+$' and v_quando is not null) then
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
    if not (public.klingo_ativo(p_conversa, 'klingo_api_cancelar') and pa.agendado_origem = 'chat_api' and pa.status = 'agendado' and v_vou ~ '^[0-9]+$') then
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

-- klingo_operacao_vigiar
CREATE OR REPLACE FUNCTION public.klingo_operacao_vigiar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
end $function$;

