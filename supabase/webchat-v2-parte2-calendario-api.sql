-- FLUXOGRAMA: entrada (o chat abre o calendário: chat_horarios; escolhe um horário: chat_horario_escolher) -> validação (token da conversa; um só procedimento; API ativa para ESTA conversa por klingo_ativo)
--   -> processamento (o calendário é montado SÓ com klingo_oferta não-sombra e não vencida; o "estado" vem do registro real da última consulta à API: com_horarios | sem_horarios | indisponivel | nao_integrado | sem_consulta; a grade catalogo_agenda / agenda_ocupacao NÃO é fonte de vaga)
--   -> persistência (a escolha guarda a chave da oferta em pre_agendamentos.escolha_horario; o horário só vira marcação pelo pipeline klingo_operacao, que revalida na API) -> saída (JSON com dias/slots como antes + estado, estado_motivo e origem)
-- Versão 2.0 — 14/11/2026 / Mudança: acaba a mistura grade x API. Antes, chat_horarios SEMPRE partia da grade (agenda_horarios) e a API só filtrava quando havia oferta; sem oferta o paciente via horário calculado como se fosse vaga.
--   Agora sem oferta da API não há horário: o estado diz por quê (API sem horário x API fora do ar x serviço sem integração) e a tela oferece as saídas certas. previsao_buscar e pedido_horario_vigiar também deixam de oferecer horário da grade.
--
-- Como voltar atrás: reaplicar supabase/producao/funcoes/{chat_horarios,chat_horario_escolher,previsao_buscar,pedido_horario_vigiar}.sql (retrato de 14/11/2026). Nenhum dado é alterado por esta migração.
-- Depende de: webchat-v2-parte1-modos.sql (klingo_ativo, klingo_consulta, klingo_oferta.sombra).

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Calendário do paciente: só ofertas reais da API
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.chat_horarios(p_conversa uuid, p_token text, p_grupo integer default 1, p_de date default null::date, p_ate date default null::date,
    p_unidade text default null::text, p_periodo text default null::text, p_excluir jsonb default '[]'::jsonb) returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare
  v_procs int[]; v_grupos jsonb; v_g jsonb; v_de date := coalesce(p_de, current_date); v_ate date; v_meta timestamptz; v_dias jsonb := '[]'::jsonb; v_unid jsonb := '[]'::jsonb; v_sem int;
  v_escolhas jsonb; v_pref text; v_med text; v_med_sem boolean := false; v_sug jsonb; v_estado text; v_motivo text; v_ult record; v_n int; v_aviso text;
  v_agora timestamp := now() at time zone 'America/Bahia'; v_todos integer;
begin
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  v_ate := least(coalesce(p_ate, v_de + 30), v_de + 45);
  select array_agg(i.procedimento_id order by i.id) into v_procs from public.pre_agendamento_itens i,
    lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  select count(*) into v_sem from public.pre_agendamento_itens where conversa_id = p_conversa and ativo and procedimento_id is null;
  if v_procs is null then
    return jsonb_build_object('grupos', '[]'::jsonb, 'sem_exame', v_sem, 'dias', '[]'::jsonb, 'aviso', 'Escolha o exame primeiro para ver os horários.', 'estado', 'sem_exame', 'origem', 'nenhuma');
  end if;
  v_todos := cardinality(v_procs);   -- total de exames do pedido (a API só marca UM procedimento por vez)
  v_grupos := public.agenda_grupos(v_procs);
  select jsonb_agg(jsonb_build_object('indice', t.ord, 'procs', t.g -> 'procs',
      'nomes', (select jsonb_agg(distinct p.nome) from jsonb_array_elements_text(t.g -> 'procs') x join public.catalogo_procedimento p on p.id = x::int)) order by t.ord)
    into v_grupos from jsonb_array_elements(v_grupos) with ordinality t(g, ord);
  v_g := v_grupos -> (greatest(p_grupo, 1) - 1);
  if v_g is null then raise exception 'Grupo inexistente.' using errcode = '22023'; end if;
  select array_agg(x::int) into v_procs from jsonb_array_elements_text(v_g -> 'procs') x;
  select escolha_horario into v_escolhas from public.pre_agendamentos where conversa_id = p_conversa;
  select c.medico_preferido into v_pref from public.conversas c where c.id = p_conversa;

  -- ESTADO: vem do que a API respondeu de verdade (klingo_consulta), nunca da grade.
  if v_todos <> 1 then v_estado := 'nao_integrado'; v_motivo := 'varios_procedimentos';
  elsif not public.klingo_ativo(p_conversa, 'klingo_api_horarios') then v_estado := 'nao_integrado'; v_motivo := 'api_desligada';
  else
    select * into v_ult from public.klingo_consulta where conversa_id = p_conversa and modo not in ('sombra', 'monitor') and em > now() - interval '30 minutes' order by id desc limit 1;   -- 'monitor' = consulta do motor de vagas, não da tela
    v_motivo := v_ult.resultado;
    v_estado := case when v_ult.id is null then 'sem_consulta'
                     when v_ult.resultado in ('ok_com_horarios', 'api_sem_horarios', 'todos_filtrados') then 'com_horarios'
                     when v_ult.resultado in ('estrutura_invalida', 'erro_api', 'limite', 'erro_gravacao') then 'indisponivel'
                     else 'nao_integrado' end;
    if v_estado = 'com_horarios' then   -- uma 2ª janela vazia não apaga as ofertas da 1ª: conta o que existe agora
      select count(*) into v_n from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora;
      v_estado := case when v_n > 0 then 'com_horarios' else 'sem_horarios' end;
    end if;
  end if;

  if v_estado = 'com_horarios' then
    v_med := v_pref;
    if v_med is not null and not exists (select 1 from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora
                                          and o.data between v_de and v_ate and public.klingo_prof_confere(o.profissional, v_med)) then
      v_med := null; v_med_sem := true;
    end if;
    with o as (
      select o.* from public.klingo_oferta o
       where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and o.data between v_de and v_ate and (o.data + o.hora::time) > v_agora
         and (p_unidade is null or p_unidade = '' or public.norm_nome(o.unidade) = public.norm_nome(p_unidade))
         and (p_periodo is null or p_periodo = '' or (p_periodo = 'manha' and o.hora < '12:00') or (p_periodo = 'tarde' and o.hora >= '12:00' and o.hora < '18:00') or (p_periodo = 'noite' and o.hora >= '18:00'))
         and (v_med is null or public.klingo_prof_confere(o.profissional, v_med))
         and not exists (select 1 from jsonb_array_elements(coalesce(v_escolhas, '[]'::jsonb)) e where (e ->> 'grupo')::int <> greatest(p_grupo, 1) and e ->> 'data' = o.data::text and e ->> 'hora' = o.hora)),
    um as (select distinct on (o.data, o.hora) o.* from o order by o.data, o.hora, o.profissional)
    select coalesce(jsonb_agg(jsonb_build_object('data', d.data, 'slots', d.slots) order by d.data), '[]'::jsonb) into v_dias
      from (select um.data, jsonb_agg(jsonb_build_object('hora', um.hora, 'unidade', um.unidade, 'profissional', um.profissional, 'local', null, 'min', 30, 'chegada', um.ordem_chegada, 'oferta', um.chave) order by um.hora) slots
              from um group by um.data) d;
    select coalesce(jsonb_agg(distinct o.unidade), '[]'::jsonb), max(o.criado_em) into v_unid, v_meta from public.klingo_oferta o
     where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and o.unidade is not null;
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
    when 'sem_horarios' then 'Não encontramos horários disponíveis para esse atendimento no momento.'
    when 'indisponivel' then 'Não foi possível consultar os horários agora.'
    when 'nao_integrado' then 'Este atendimento é agendado pela nossa equipe.'
    else null end;
  return jsonb_build_object('janelas', '{}'::jsonb, 'grupos', v_grupos, 'grupo', greatest(p_grupo, 1), 'de', v_de, 'ate', v_ate, 'dias', v_dias, 'unidades', v_unid,
    'escolhas', coalesce(v_escolhas, '[]'::jsonb), 'sem_exame', v_sem, 'medico_preferido', v_pref, 'medico_filtrando', v_med is not null, 'medico_sem_horario', v_med_sem, 'sugerido', v_sug,
    'atualizado_em', v_meta, 'klingo_api', v_estado = 'com_horarios', 'estado', v_estado, 'estado_motivo', v_motivo, 'origem', case when v_estado = 'com_horarios' then 'api_klingo' else 'nenhuma' end, 'aviso', v_aviso);
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. Escolha: só vale oferta REAL, ainda válida, da API
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.chat_horario_escolher(p_conversa uuid, p_token text, p_grupo integer, p_data date, p_hora text, p_unidade text default null::text) returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare
  v_procs int[]; v_grupos jsonb; v_g jsonb; v_o public.klingo_oferta; v_escolhas jsonb; v_outros jsonb; v_novo jsonb; v_total int; v_feitos int; v_txt text; v_msg bigint; v_conf boolean := false; v_todos integer;
  v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
begin
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

  -- a oferta TEM de existir agora (a API a devolveu há menos de 30 min) e não pode ter sido escolhida em outro grupo
  select * into v_o from public.klingo_oferta o
   where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and o.data = p_data and o.hora = p_hora
     and (p_unidade is null or p_unidade = '' or public.norm_nome(o.unidade) = public.norm_nome(p_unidade))
     and not exists (select 1 from jsonb_array_elements(v_outros) e where e ->> 'data' = o.data::text and e ->> 'hora' = o.hora)
   order by o.id limit 1;
  if v_o.id is null then raise exception 'Esse horário acabou de ficar indisponível. Escolha outro, por favor.' using errcode = 'P0002'; end if;
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

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. A previsão antiga também deixa de usar a grade
-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- previsao_buscar: até 2 horários REAIS (ofertas da API desta conversa) dentro do turno, do período e da antecedência. Sem oferta, devolve lista vazia.
create or replace function public.previsao_buscar(p_conversa uuid, p_turno text, p_de date, p_ate date, p_antec_min integer) returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare v_todos jsonb; v_s1 jsonb; v_s2 jsonb; v_agora timestamp := now() at time zone 'America/Bahia';
begin
  select coalesce(jsonb_agg(to_jsonb(x) - 'ord' order by x.ord), '[]'::jsonb) into v_todos from (
    select o.data, o.hora, o.unidade, null::text as local, o.profissional, 30 as min, o.ordem_chegada as chegada, o.chave as oferta, row_number() over (order by o.data, o.hora) as ord
      from public.klingo_oferta o
     where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and o.data between p_de and p_ate
       and (o.data + o.hora::time) >= v_agora + make_interval(mins => coalesce(p_antec_min, 0))
       and (p_turno is null or p_turno = 'qualquer' or (p_turno = 'manha' and o.hora < '12:00') or (p_turno = 'tarde' and o.hora >= '12:00' and o.hora < '18:00'))
     limit 60) x;
  v_s1 := v_todos -> 0;
  if v_s1 is null then return '[]'::jsonb; end if;
  select s into v_s2 from jsonb_array_elements(v_todos) with ordinality t(s, ord) where ord > 1 order by (s ->> 'data' = v_s1 ->> 'data'), ord limit 1;
  return case when v_s2 is null then jsonb_build_array(v_s1) else jsonb_build_array(v_s1, v_s2) end;
end $function$;

-- pedido_horario_vigiar: a oferta automática do "horário mais próximo" vinha da grade. Agora, pedido sem horário vira alerta para a equipe (ramo "else" existente); nada é oferecido.
do $m$
declare d text := pg_get_functiondef('public.pedido_horario_vigiar()'::regprocedure); k text := 'if r.cstatus = ''aguardando'' and r.motor = ''fluxo'' and v_procs is not null and jsonb_array_length(public.agenda_grupos(v_procs)) = 1 then'; n integer;
begin
  n := (length(d) - length(replace(d, k, ''))) / length(k);
  if n <> 1 then raise exception 'pedido_horario_vigiar: trecho da oferta automática não encontrado exatamente uma vez (%)', n; end if;
  execute replace(d, k, 'if false then   -- v2.0: a oferta automática saía da grade (não é vaga); agora só a equipe é avisada');
end $m$;

revoke all on function public.previsao_buscar(uuid, text, date, date, integer) from public, anon, authenticated;
grant execute on function public.previsao_buscar(uuid, text, date, date, integer) to service_role;
