-- ROLLBACK de supabase/medico-escolhido-fica-parte1..5.sql (17/11/2026): recria as 5 funções como estavam na produção antes da mudança e apaga a função nova.
-- Aplicar em partes pequenas (a ferramenta de migração expira em 60 s). O front (index.html) da versão 2026.11.17-1 chama chat_medico_sem_horario_abrir: ao voltar o banco, volte também o chat.

-- chat_horarios
CREATE OR REPLACE FUNCTION public.chat_horarios(p_conversa uuid, p_token text, p_grupo integer DEFAULT 1, p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_periodo text DEFAULT NULL::text, p_excluir jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_procs int[]; v_grupos jsonb; v_g jsonb; v_de date := coalesce(p_de, current_date); v_ate date; v_meta timestamptz; v_dias jsonb := '[]'::jsonb; v_unid jsonb := '[]'::jsonb; v_sem int;
  v_escolhas jsonb; v_pref text; v_med text; v_med_sem boolean := false; v_sug jsonb; v_estado text; v_motivo text; v_ult record; v_n int; v_aviso text; v_bloq int := 0;
  v_agora timestamp := now() at time zone 'America/Bahia'; v_todos integer;
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  v_ate := least(coalesce(p_ate, v_de + 30), v_de + 45);
  select array_agg(i.procedimento_id order by i.id) into v_procs from public.pre_agendamento_itens i,
    lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  select count(*) into v_sem from public.pre_agendamento_itens where conversa_id = p_conversa and ativo and procedimento_id is null;
  if v_procs is null then
    return jsonb_build_object('grupos', '[]'::jsonb, 'sem_exame', v_sem, 'dias', '[]'::jsonb, 'aviso', 'Escolha o exame primeiro para ver os horários.', 'estado', 'sem_exame', 'origem', 'nenhuma');
  end if;
  v_todos := cardinality(v_procs);
  v_grupos := public.agenda_grupos(v_procs);
  select jsonb_agg(jsonb_build_object('indice', t.ord, 'procs', t.g -> 'procs',
      'nomes', (select jsonb_agg(distinct p.nome) from jsonb_array_elements_text(t.g -> 'procs') x join public.catalogo_procedimento p on p.id = x::int)) order by t.ord)
    into v_grupos from jsonb_array_elements(v_grupos) with ordinality t(g, ord);
  v_g := v_grupos -> (greatest(p_grupo, 1) - 1);
  if v_g is null then raise exception 'Grupo inexistente.' using errcode = '22023'; end if;
  select array_agg(x::int) into v_procs from jsonb_array_elements_text(v_g -> 'procs') x;
  select escolha_horario into v_escolhas from public.pre_agendamentos where conversa_id = p_conversa;
  select c.medico_preferido into v_pref from public.conversas c where c.id = p_conversa;

  if v_todos <> 1 then v_estado := 'nao_integrado'; v_motivo := 'varios_procedimentos';
  elsif not public.klingo_ativo(p_conversa, 'klingo_api_horarios') then v_estado := 'nao_integrado'; v_motivo := 'api_desligada';
  else
    select * into v_ult from public.klingo_consulta where conversa_id = p_conversa and modo not in ('sombra', 'monitor') and em > now() - interval '30 minutes' order by id desc limit 1;
    v_motivo := v_ult.resultado;
    v_estado := case when v_ult.id is null then 'sem_consulta'
                     when v_ult.resultado in ('ok_com_horarios', 'api_sem_horarios', 'todos_filtrados') then 'com_horarios'
                     when v_ult.resultado in ('estrutura_invalida', 'erro_api', 'limite', 'erro_gravacao') then 'indisponivel'
                     else 'nao_integrado' end;
    if v_estado = 'com_horarios' then
      select count(*) into v_n from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora and public.unidade_marca_auto(o.unidade);
      select count(*) into v_bloq from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora and not public.unidade_marca_auto(o.unidade);
      v_estado := case when v_n > 0 then 'com_horarios' else 'sem_horarios' end;
    end if;
  end if;

  if v_estado = 'com_horarios' then
    v_med := v_pref;
    if v_med is not null and not exists (select 1 from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora and public.unidade_marca_auto(o.unidade)
                                          and o.data between v_de and v_ate and public.klingo_prof_confere(o.profissional, v_med)) then
      v_med := null; v_med_sem := true;
    end if;
    with o as (
      select o.* from public.klingo_oferta o
       where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and o.data between v_de and v_ate and (o.data + o.hora::time) > v_agora
         and public.unidade_marca_auto(o.unidade)
         and (p_unidade is null or p_unidade = '' or public.norm_nome(o.unidade) = public.norm_nome(p_unidade))
         and (p_periodo is null or p_periodo = '' or (p_periodo = 'manha' and o.hora < '12:00') or (p_periodo = 'tarde' and o.hora >= '12:00' and o.hora < '18:00') or (p_periodo = 'noite' and o.hora >= '18:00'))
         and (v_med is null or public.klingo_prof_confere(o.profissional, v_med))
         and not exists (select 1 from jsonb_array_elements(coalesce(v_escolhas, '[]'::jsonb)) e where (e ->> 'grupo')::int <> greatest(p_grupo, 1) and e ->> 'data' = o.data::text and e ->> 'hora' = o.hora)),
    um as (select distinct on (o.data, o.hora) o.* from o order by o.data, o.hora, o.profissional)
    select coalesce(jsonb_agg(jsonb_build_object('data', d.data, 'slots', d.slots) order by d.data), '[]'::jsonb) into v_dias
      from (select um.data, jsonb_agg(jsonb_build_object('hora', um.hora, 'unidade', um.unidade, 'profissional', um.profissional, 'local', null, 'min', 30, 'chegada', um.ordem_chegada, 'oferta', um.chave) order by um.hora) slots
              from um group by um.data) d;
    select coalesce(jsonb_agg(distinct o.unidade), '[]'::jsonb), max(o.criado_em) into v_unid, v_meta from public.klingo_oferta o
     where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and o.unidade is not null and public.unidade_marca_auto(o.unidade);
    select jsonb_build_object('data', s.data, 'hora', s.hora, 'unidade', s.unidade, 'profissional', s.profissional, 'apos', pc.paciente_nome) into v_sug
    from public.conversas c join public.conversas pc on pc.id = c.irmao_de
    join public.pre_agendamentos pp on pp.conversa_id = pc.id and jsonb_typeof(pp.escolha_horario) = 'array'
    cross join lateral (select e from jsonb_array_elements(pp.escolha_horario) e where (e ->> 'grupo')::int = greatest(p_grupo, 1) limit 1) pe
    cross join lateral (select d.data, sl ->> 'hora' as hora, sl ->> 'unidade' as unidade, sl ->> 'profissional' as profissional
        from jsonb_to_recordset(v_dias) as d(data date, slots jsonb), jsonb_array_elements(d.slots) sl
        where d.data = (pe.e ->> 'data')::date
          and (sl ->> 'hora')::time >= (pe.e ->> 'hora')::time + make_interval(mins => coalesce((pe.e ->> 'min')::int, 30))
        order by ((sl ->> 'profissional') = (pe.e ->> 'profissional')) desc, sl ->> 'hora' limit 1) s
    where c.id = p_conversa and c.irmaos_modo = 'juntos';
  end if;

  v_aviso := case v_estado
    when 'sem_horarios' then case when v_bloq > 0 then public.unidade_aviso_bloqueio() else 'Não encontramos horários disponíveis para esse atendimento no momento.' end
    when 'indisponivel' then 'Não foi possível consultar os horários agora.'
    when 'nao_integrado' then 'Este atendimento é agendado pela nossa equipe.'
    else null end;
  return jsonb_build_object('janelas', '{}'::jsonb, 'grupos', v_grupos, 'grupo', greatest(p_grupo, 1), 'de', v_de, 'ate', v_ate, 'dias', v_dias, 'unidades', v_unid,
    'escolhas', coalesce(v_escolhas, '[]'::jsonb), 'sem_exame', v_sem, 'medico_preferido', v_pref, 'medico_filtrando', v_med is not null, 'medico_sem_horario', v_med_sem, 'sugerido', v_sug,
    'atualizado_em', v_meta, 'klingo_api', v_estado = 'com_horarios', 'estado', v_estado, 'estado_motivo', v_motivo, 'origem', case when v_estado = 'com_horarios' then 'api_klingo' else 'nenhuma' end, 'aviso', v_aviso, 'unidades_bloqueadas', v_bloq > 0);
end $function$;

-- chat_horario_escolher
CREATE OR REPLACE FUNCTION public.chat_horario_escolher(p_conversa uuid, p_token text, p_grupo integer, p_data date, p_hora text, p_unidade text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_procs int[]; v_grupos jsonb; v_g jsonb; v_o public.klingo_oferta; v_escolhas jsonb; v_outros jsonb; v_novo jsonb; v_total int; v_feitos int; v_txt text; v_msg bigint; v_conf boolean := false; v_todos integer;
  v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  if p_data is null or p_hora !~ '^\d{2}:\d{2}$' or p_data < current_date or p_data > current_date + 60 then raise exception 'Data inválida.' using errcode = '22023'; end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  perform pg_advisory_xact_lock(hashtext('agenda:' || p_data::text));
  select array_agg(i.procedimento_id order by i.id) into v_procs from public.pre_agendamento_itens i,
    lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  if v_procs is null then raise exception 'Escolha o exame primeiro.' using errcode = '22023'; end if;
  v_todos := cardinality(v_procs);
  v_grupos := public.agenda_grupos(v_procs);
  v_total := jsonb_array_length(v_grupos);
  v_g := v_grupos -> (greatest(p_grupo, 1) - 1);
  if v_g is null then raise exception 'Grupo inexistente.' using errcode = '22023'; end if;
  select array_agg(x::int) into v_procs from jsonb_array_elements_text(v_g -> 'procs') x;
  if v_todos <> 1 or not public.klingo_ativo(p_conversa, 'klingo_api_horarios') then
    raise exception 'Este atendimento é agendado pela equipe; não há horário para escolher aqui.' using errcode = 'P0001';
  end if;

  select coalesce(escolha_horario, '[]'::jsonb) into v_escolhas from public.pre_agendamentos where conversa_id = p_conversa;
  v_escolhas := coalesce(v_escolhas, '[]'::jsonb);
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_outros from jsonb_array_elements(v_escolhas) e where (e ->> 'grupo')::int <> greatest(p_grupo, 1);

  select * into v_o from public.klingo_oferta o
   where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and o.data = p_data and o.hora = p_hora
     and (p_unidade is null or p_unidade = '' or public.norm_nome(o.unidade) = public.norm_nome(p_unidade))
     and not exists (select 1 from jsonb_array_elements(v_outros) e where e ->> 'data' = o.data::text and e ->> 'hora' = o.hora)
   order by o.id limit 1;
  if v_o.id is null then raise exception 'Esse horário acabou de ficar indisponível. Escolha outro, por favor.' using errcode = 'P0002'; end if;
  if not public.unidade_marca_auto(v_o.unidade) then raise exception '%', public.unidade_aviso_bloqueio() using errcode = 'P0001'; end if;
  v_conf := public.klingo_ativo(p_conversa, 'klingo_api_marcar');

  v_novo := jsonb_build_object('grupo', greatest(p_grupo, 1), 'data', p_data, 'hora', v_o.hora, 'unidade', v_o.unidade, 'profissional', v_o.profissional, 'local', null, 'min', 30, 'chegada', v_o.ordem_chegada,
                               'origem', 'klingo_api', 'klingo_chave', v_o.chave);
  v_escolhas := v_outros || jsonb_build_array(v_novo);
  v_feitos := jsonb_array_length(v_escolhas);

  update public.pre_agendamentos set escolha_horario = v_escolhas,
    data_desejada = (select (e ->> 'data')::date from jsonb_array_elements(v_escolhas) e order by (e ->> 'grupo')::int limit 1),
    hora_desejada = (select e ->> 'hora' from jsonb_array_elements(v_escolhas) e order by (e ->> 'grupo')::int limit 1),
    unidade = coalesce(unidade, v_o.unidade),
    etapa = case when v_feitos >= v_total then 'dados' else 'data_hora' end, atualizado_em = now()
  where conversa_id = p_conversa and (status not in ('agendado','cancelado')
        or (status = 'agendado' and exists (select 1 from public.conversa_fluxo f where f.conversa_id = p_conversa and jsonb_typeof(f.dados -> 'remarcando') = 'object')));

  v_txt := format('Escolhi %s, %s/%s%s%s. %s',
    v_dias[extract(dow from p_data)::int + 1], to_char(p_data, 'DD'), to_char(p_data, 'MM'),
    case when v_o.ordem_chegada then ', por ordem de chegada a partir das ' || v_o.hora else ' às ' || v_o.hora end,
    case when v_o.unidade is not null then ' — ' || v_o.unidade else '' end,
    case when v_conf then '(Horário livre na agenda agora; ainda não está marcado: falta a minha confirmação.)' else '(Horário livre na agenda agora; a equipe confirma a marcação.)' end);
  if v_total > 1 then v_txt := format('Horário %s de %s: %s', greatest(p_grupo, 1), v_total, v_txt); end if;
  update public.conversas set status = case when status = 'encerrada' then 'aguardando' else status end where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_msg;
  return jsonb_build_object('ok', true, 'restantes', greatest(v_total - v_feitos, 0), 'escolha', v_novo, 'mensagem_id', v_msg);
end $function$;

-- klingo_pode_marcar
CREATE OR REPLACE FUNCTION public.klingo_pode_marcar(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa public.pre_agendamentos; d jsonb; e jsonb; o public.klingo_oferta; v_id jsonb; v_pl jsonb; v_novo boolean := false; v_rem boolean := false;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if not public.klingo_ativo(p_conversa, 'klingo_api_marcar') then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  v_rem := coalesce((select jsonb_typeof(f.dados -> 'remarcando') = 'object' from public.conversa_fluxo f where f.conversa_id = p_conversa), false);
  if pa.id is null or (pa.status = 'agendado' and not v_rem) then return jsonb_build_object('ok', false, 'motivo', 'ja_agendado'); end if;
  if v_rem and ((pa.agendado_origem is distinct from 'chat_api' and not exists (select 1 from public.klingo_marcacao km where km.conversa_id = p_conversa and km.situacao = 'ativa' and km.consultado_em > now() - interval '6 hours' and km.voucher = (select f2.dados -> 'remarcando' ->> 'voucher' from public.conversa_fluxo f2 where f2.conversa_id = p_conversa))) or not public.klingo_ativo(p_conversa, 'klingo_api_remarcar')) then return jsonb_build_object('ok', false, 'motivo', 'remarcar_desligado'); end if;
  -- particular-valor: paciente Particular só é cadastrado no Klingo se viu e ACEITOU o valor
  if public.particular_valor_ativo(p_conversa) and not coalesce((select f.dados -> 'valor_resp' ->> 'resp' = 'aceito' and f.dados -> 'valor_resp' ->> 'assin' = public.particular_valor_assinatura(p_conversa)
       from public.conversa_fluxo f where f.conversa_id = p_conversa), false) then
    return jsonb_build_object('ok', false, 'motivo', 'valor_nao_aceito', 'detalhe', 'o paciente Particular não aceitou (ou não viu) o valor');
  end if;
  -- primeira-consulta: segunda trava (a primeira fica em fluxo_proximo); sem histórico com a médica não marca sozinho
  if pa.tipo = 'consulta' and coalesce((public.primeira_consulta_ok(p_conversa) ->> 'bloqueia')::boolean, false) then
    return jsonb_build_object('ok', false, 'motivo', 'primeira_consulta', 'detalhe', 'primeira consulta com a médica: só a atendente marca');
  end if;
  d := public.klingo_dados_conversa(p_conversa);
  if (d ->> 'n_procedimentos')::int <> 1 then return jsonb_build_object('ok', false, 'motivo', 'varios_procedimentos'); end if;
  if jsonb_typeof(pa.escolha_horario) <> 'array' or jsonb_array_length(pa.escolha_horario) <> 1 then return jsonb_build_object('ok', false, 'motivo', 'horario_nao_unico'); end if;
  e := pa.escolha_horario -> 0;
  select * into o from public.klingo_oferta where conversa_id = p_conversa and chave = e ->> 'klingo_chave' and not sombra and expira_em > now() - interval '20 minutes';
  if o.id is null then
    return jsonb_build_object('ok', false, 'motivo', 'sem_oferta_da_api',
      'detalhe', coalesce(public.klingo_motivo_texto(p_conversa), 'o chat não recebeu horários reais do Klingo nesta conversa (o horário escolhido veio da grade)'));
  end if;
  if not public.unidade_marca_auto(o.unidade) then return jsonb_build_object('ok', false, 'motivo', 'unidade_bloqueada', 'detalhe', 'marcação automática desligada para esta unidade em Configurações'); end if;
  if o.procedimento is distinct from (d ->> 'procedimento')::int
     and not exists (select 1 from public.klingo_especialidade e where (d ->> 'procedimento')::int = any (e.procedimentos) and o.procedimento = any (e.procedimentos)) then
    return jsonb_build_object('ok', false, 'motivo', 'oferta_de_outro_procedimento');
  end if;
  if d ->> 'cpf' is null or d ->> 'nascimento' is null or d ->> 'nome' is null or d ->> 'sexo' is null then return jsonb_build_object('ok', false, 'motivo', 'dados_incompletos'); end if;
  v_id := d -> 'identidade';
  if v_id is not null and jsonb_typeof(v_id) = 'object' then
    if v_id ->> 'situacao' in ('divergente', 'sem_id_definitivo') then return jsonb_build_object('ok', false, 'motivo', 'cadastro_divergente'); end if;
    if v_id ->> 'situacao' = 'nao_encontrado' then v_novo := true; end if;
  end if;
  if v_novo and not public.klingo_ativo(p_conversa, 'klingo_api_pre_cadastro') then return jsonb_build_object('ok', false, 'motivo', 'paciente_novo'); end if;
  v_pl := public.klingo_plano_resolver(public.plano_exato_chave(p_conversa), nullif(v_id ->> 'plano_id', '')::int);
  if (v_pl ->> 'plano_id') is null and not (v_id is null or v_id ->> 'situacao' is null) then return jsonb_build_object('ok', false, 'motivo', coalesce(v_pl ->> 'motivo', 'sem_plano')); end if;
  if (v_pl ->> 'plano_id') is not null and (v_pl ->> 'plano_id')::int is distinct from o.plano and (v_pl ->> 'via') in ('padrao', 'escolhido') and o.plano <> (v_pl ->> 'plano_id')::int and v_id is not null then
    return jsonb_build_object('ok', false, 'motivo', 'plano_mudou_depois_da_oferta');
  end if;
  if pa.tipo = 'exame' and public.norm_nome(pa.plano) <> 'PARTICULAR' and public.klingo_cfg('klingo_api_exame_convenio', 'nao') <> 'sim' then
    return jsonb_build_object('ok', false, 'motivo', 'exame_com_convenio');
  end if;
  return jsonb_build_object('ok', true, 'novo', v_novo, 'remarcar', v_rem);
end $function$;

-- chat_disponibilidade_registrar
CREATE OR REPLACE FUNCTION public.chat_disponibilidade_registrar(p_conversa uuid, p_token text, p_dados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_r jsonb; v_texto text; v_prox text;
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  if not public.klingo_ativo(p_conversa, 'previsao_modo') then raise exception 'Este recurso ainda não está disponível para você. A equipe pode ajudar.' using errcode = 'P0001'; end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  v_r := public.disponibilidade_gravar(p_conversa, coalesce(p_dados, '{}'::jsonb));
  v_texto := 'Registrei a sua disponibilidade para ' || coalesce(v_r ->> 'procedimento', 'o atendimento') || ', de ' || to_char((v_r ->> 'data_ini')::date, 'DD/MM') || ' a ' || to_char((v_r ->> 'data_fim')::date, 'DD/MM') || '.'
    || E'\n\nIsso NÃO é um agendamento e não reserva horário: é um pedido para avisarmos você quando surgir uma vaga compatível. '
    || case when (v_r ->> 'aceita_notificacao')::boolean then 'Quando isso acontecer, você receberá um aviso aqui no chat e poderá tentar agendar na hora.' else 'Você não autorizou avisos; para acompanhar, volte aqui e toque em "Minha disponibilidade".' end;
  perform public.fluxo_dizer(p_conversa, v_texto, jsonb_build_object('tipo', 'disponibilidade_registrada', 'id', v_r ->> 'id'));
  perform public.fluxo_set(p_conversa, jsonb_build_object('sem_horario', true, 'disponibilidade', v_r ->> 'id'));
  perform public.fluxo_nota(p_conversa, 'SOLICITAÇÃO DE DISPONIBILIDADE FUTURA registrada (NÃO é agendamento e não reserva horário). Procura automática de vaga: ativa. Nada a fazer pela equipe agora.');
  v_prox := public.fluxo_proximo(p_conversa);
  if v_prox = 'pronto' then perform public.fluxo_finalizar(p_conversa); else perform public.fluxo_perguntar(p_conversa, v_prox, null); end if;
  if public.klingo_cfg('disponibilidade_encerra_conversa', 'nao') = 'sim' and not exists (select 1 from public.klingo_operacao o where o.conversa_id = p_conversa and o.estado in ('pendente', 'executando', 'incerto')) then
    update public.conversas set status = 'encerrada', encerrada_em = now(), motivo_encerramento = 'outro', encerramento_origem = 'sistema' where id = p_conversa and status <> 'encerrada' and primeiro_humano_em is null;
  end if;
  return jsonb_build_object('ok', true, 'solicitacao', v_r);
end $function$;

-- chat_disponibilidade_alterar
CREATE OR REPLACE FUNCTION public.chat_disponibilidade_alterar(p_conversa uuid, p_token text, p_id uuid, p_dados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.disponibilidade_pedido; v_r jsonb;
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  perform public.chat_valida(p_conversa, p_token);
  r := public.disponibilidade_do_paciente(p_conversa, p_id);
  if r.estado in ('expirada', 'cancelada', 'convertida_em_agendamento') then raise exception 'Esta solicitação já terminou. Faça uma nova.' using errcode = 'P0001'; end if;
  v_r := public.disponibilidade_gravar(p_conversa, coalesce(p_dados, '{}'::jsonb) || jsonb_build_object('unidade', coalesce(p_dados ->> 'unidade', r.unidade)), r.id);
  return jsonb_build_object('ok', true, 'solicitacao', v_r);
end $function$;

drop function if exists public.chat_medico_sem_horario_abrir(uuid, text, jsonb);
drop function if exists public.chat_medico_sem_horario_abrir(uuid, text);
