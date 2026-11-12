-- public.chat_horarios(p_conversa uuid, p_token text, p_grupo integer, p_de date, p_ate date, p_unidade text, p_periodo text, p_excluir jsonb)
-- Pode executar: anon, authenticated
CREATE OR REPLACE FUNCTION public.chat_horarios(p_conversa uuid, p_token text, p_grupo integer DEFAULT 1, p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_periodo text DEFAULT NULL::text, p_excluir jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_procs int[]; v_grupos jsonb; v_g jsonb; v_de date := coalesce(p_de, current_date); v_ate date; v_meta timestamptz; v_dias jsonb; v_unid jsonb; v_sem int; v_escolhas jsonb; v_titulo text; v_jan jsonb; v_pref text; v_med text; v_med_sem boolean := false; v_sug jsonb; v_api boolean := false;   -- klingo-auto
begin
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  v_ate := least(coalesce(p_ate, v_de + 30), v_de + 45);
  select array_agg(i.procedimento_id order by i.id) into v_procs from public.pre_agendamento_itens i,
    lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  select count(*) into v_sem from public.pre_agendamento_itens where conversa_id = p_conversa and ativo and procedimento_id is null;
  if v_procs is null then
    return jsonb_build_object('grupos', '[]'::jsonb, 'sem_exame', v_sem, 'dias', '[]'::jsonb, 'aviso', 'Escolha o exame primeiro para ver os horários.');
  end if;
  v_grupos := public.agenda_grupos(v_procs);
  select jsonb_agg(jsonb_build_object('indice', t.ord, 'procs', t.g -> 'procs',
      'nomes', (select jsonb_agg(distinct p.nome) from jsonb_array_elements_text(t.g -> 'procs') x join public.catalogo_procedimento p on p.id = x::int)) order by t.ord)
    into v_grupos from jsonb_array_elements(v_grupos) with ordinality t(g, ord);
  v_g := v_grupos -> (greatest(p_grupo, 1) - 1);
  if v_g is null then raise exception 'Grupo inexistente.' using errcode = '22023'; end if;
  select array_agg(x::int) into v_procs from jsonb_array_elements_text(v_g -> 'procs') x;
  select escolha_horario into v_escolhas from public.pre_agendamentos where conversa_id = p_conversa;
  select m.atualizado_em into v_meta from public.agenda_ocupacao_meta m where m.id = 1;

  -- klingo-auto: com a API ligada para esta conversa, só aparecem os horários que o Klingo também oferece agora (as regras locais continuam valendo por cima)
  v_api := cardinality(v_procs) = 1 and public.klingo_horarios_api_ativa(p_conversa)
           and exists (select 1 from public.klingo_oferta o where o.conversa_id = p_conversa and o.expira_em > now());
  select c.medico_preferido into v_pref from public.conversas c where c.id = p_conversa;
  v_med := v_pref;
  if v_med is not null and not exists (select 1 from public.agenda_horarios(v_procs, v_de, v_ate, p_unidade, v_med, p_periodo, '[]'::jsonb)) then
    v_med := null; v_med_sem := true;
  end if;
  with h0 as (select * from public.agenda_horarios(v_procs, v_de, v_ate, p_unidade, v_med, p_periodo, coalesce(p_excluir, '[]'::jsonb) || coalesce((select jsonb_agg(jsonb_build_object('data', e ->> 'data', 'hora', e ->> 'hora', 'min', coalesce((e ->> 'min')::int, 30), 'unidade', e ->> 'unidade')) from jsonb_array_elements(coalesce(v_escolhas, '[]'::jsonb)) e where (e ->> 'grupo')::int <> greatest(p_grupo, 1)), '[]'::jsonb))),
  h as (select h0.* from h0 where not v_api or exists (select 1 from public.klingo_oferta o where o.conversa_id = p_conversa and o.expira_em > now() and o.data = h0.data and o.hora = h0.hora and public.klingo_prof_confere(o.profissional, h0.profissional))),
  um as (select distinct on (h.data, h.hora) h.* from h order by h.data, h.hora, h.profissional)
  select coalesce(jsonb_agg(jsonb_build_object('data', d.data, 'slots', d.slots) order by d.data), '[]'::jsonb) into v_dias
  from (select um.data, jsonb_agg(jsonb_build_object('hora', um.hora, 'unidade', um.unidade, 'profissional', um.profissional, 'local', um.local, 'min', um.duracao_min, 'chegada', um.chegada) order by um.hora) slots
        from um group by um.data) d;
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
  select coalesce(jsonb_agg(distinct a.unidade), '[]'::jsonb) into v_unid from public.catalogo_agenda a
    where a.procedimento_id = any(v_procs) and a.vig_fim >= current_date and a.profissional !~* 'teste';

  select coalesce(jsonb_object_agg(j.dia_num::text, jsonb_build_object('ini', j.ini, 'fim', j.fim, 'passo', j.passo)), '{}'::jsonb) into v_jan from (
    select a.dia_num, min(a.hora_ini) as ini, max(a.hora_fim) as fim, min(a.duracao_min) filter (where a.duracao_min > 5) as passo
    from public.catalogo_agenda a join public.catalogo_procedimento pm on pm.id = a.procedimento_id
    left join public.agenda_modalidade_local ml on ml.modalidade = pm.modalidade
    where a.procedimento_id = any(v_procs) and a.vig_fim >= v_de and a.vig_ini <= v_ate and a.profissional !~* 'teste'
      and (ml.local_padrao is null or a.local ~* ml.local_padrao) and (a.duracao_min > 5 or a.hora_fim::time - a.hora_ini::time >= interval '60 minutes')
      and (p_unidade is null or public.norm_nome(a.unidade) = public.norm_nome(p_unidade))
    group by a.dia_num) j;
  return jsonb_build_object('janelas', v_jan, 'grupos', v_grupos, 'grupo', greatest(p_grupo, 1), 'de', v_de, 'ate', v_ate, 'dias', v_dias, 'unidades', v_unid,
    'escolhas', coalesce(v_escolhas, '[]'::jsonb), 'sem_exame', v_sem, 'medico_preferido', v_pref, 'medico_filtrando', v_med is not null, 'medico_sem_horario', v_med_sem, 'sugerido', v_sug, 'atualizado_em', v_meta, 'klingo_api', v_api,
    'aviso', case when v_api then null when v_meta is null then 'Horários calculados pela grade de atendimento; o atendente confirma a disponibilidade.'
                  when v_meta < now() - interval '60 minutes' then 'Os horários podem ter mudado nos últimos minutos; o atendente confirma.' else null end);
end $function$;

