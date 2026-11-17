-- FLUXOGRAMA: entrada (o paciente escolheu um médico no começo do pedido: conversas.medico_preferido)
--   -> validação (a escolha do paciente nunca é trocada nem perguntada de novo: sem botão "Ver outros médicos", sem lista de outros médicos)
--   -> lógica (chat_horarios mostra SÓ os horários do médico escolhido; o chat procura nas 3 janelas da API, 45 dias; chat_horario_escolher e klingo_pode_marcar recusam horário de outro médico;
--      sem horário do médico em 45 dias, chat_medico_sem_horario_abrir abre a solicitação de disponibilidade futura, só com esse médico, para a atendente avaliar)
--   -> saída (o paciente é avisado, o pedido segue para a equipe com uma nota; nada é marcado no Klingo).
-- Versão 1.0 — 17/11/2026 / Mudança: pedido do dono depois do caso de uma paciente que pediu uma médica e o chat marcou com outra (o chat mostrava os horários de todos quando a médica não tinha vaga nos primeiros 15 dias).
-- Sem "drop": a ferramenta de migração pede confirmação para comandos que parecem destrutivos e expira em 60 s.
-- ROLLBACK: supabase/medico-escolhido-fica-rollback.sql (recria as 5 funções alteradas a partir de supabase/producao/funcoes/ antes do retrato novo e apaga chat_medico_sem_horario_abrir).

-- Parte 1: chat_horarios deixa de cair para os outros médicos
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
    v_med := v_pref;   -- a escolha do paciente nunca é trocada: sem horário dele(a), a lista fica vazia e v_med_sem avisa
    v_med_sem := v_med is not null and not exists (select 1 from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > v_agora and public.unidade_marca_auto(o.unidade)
                                          and o.data between v_de and v_ate and public.klingo_prof_confere(o.profissional, v_med));
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
     where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and o.unidade is not null and public.unidade_marca_auto(o.unidade) and (v_med is null or public.klingo_prof_confere(o.profissional, v_med));
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
