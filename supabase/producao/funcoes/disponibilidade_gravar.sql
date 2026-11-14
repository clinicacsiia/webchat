-- public.disponibilidade_gravar(p_conversa uuid, p_dados jsonb, p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_gravar(p_conversa uuid, p_dados jsonb, p_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  pa public.pre_agendamentos; c public.conversas; d jsonb := public.klingo_dados_conversa(p_conversa); v_procs integer[]; v_pessoa text; v_ini date; v_fim date; v_dias smallint[]; v_turno text; v_canais text[]; v_aceita boolean;
  v_id uuid; v_novo boolean; v_nome text; v_hi text := nullif(p_dados ->> 'hora_ini', ''); v_hf text := nullif(p_dados ->> 'hora_fim', ''); v_tipo_pac text; r public.disponibilidade_pedido; v_total integer;
begin
  select * into c from public.conversas where id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if pa.id is null then raise exception 'Escolha o exame ou a consulta primeiro.' using errcode = '22023'; end if;
  select array_agg(distinct i.procedimento_id order by i.procedimento_id) into v_procs from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  if v_procs is null then raise exception 'Escolha o exame ou a consulta primeiro.' using errcode = '22023'; end if;
  select count(*) into v_total from public.pre_agendamento_itens i, lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  if v_total <> 1 or not public.klingo_automatizavel(v_procs[1], coalesce(pa.tipo, 'exame')) then
    raise exception 'Este atendimento é agendado pela nossa equipe: não há busca automática de vaga para ele.' using errcode = 'P0001';
  end if;
  v_pessoa := public.disponibilidade_pessoa_chave(p_conversa);
  if v_pessoa is null then raise exception 'Informe o CPF e a data de nascimento antes.' using errcode = '22023'; end if;
  v_ini := greatest(coalesce(nullif(p_dados ->> 'data_ini', '')::date, current_date), current_date);
  v_fim := coalesce(nullif(p_dados ->> 'data_fim', '')::date, v_ini + 60);
  if v_fim < v_ini then raise exception 'A data final precisa ser depois da inicial.' using errcode = '22023'; end if;
  if v_fim > current_date + 365 then raise exception 'O período pode ir até 1 ano.' using errcode = '22023'; end if;
  v_dias := coalesce((select array_agg(distinct x::smallint order by x::smallint) from jsonb_array_elements_text(case when jsonb_typeof(p_dados -> 'dias_semana') = 'array' then p_dados -> 'dias_semana' else '[]'::jsonb end) x where x ~ '^[0-6]$'), '{}'::smallint[]);
  if cardinality(v_dias) = 0 then v_dias := '{0,1,2,3,4,5,6}'::smallint[]; end if;
  v_turno := coalesce(nullif(p_dados ->> 'turno', ''), 'qualquer');
  if v_turno not in ('manha', 'tarde', 'noite', 'qualquer') then raise exception 'Turno inválido.' using errcode = '22023'; end if;
  if (v_hi is not null and v_hi !~ '^\d{2}:\d{2}$') or (v_hf is not null and v_hf !~ '^\d{2}:\d{2}$') or (v_hi is not null and v_hf is not null and v_hf <= v_hi) then raise exception 'Horário inválido.' using errcode = '22023'; end if;
  v_aceita := coalesce((p_dados ->> 'aceita_notificacao')::boolean, false);
  v_canais := case when v_aceita then coalesce((select array_agg(distinct x) from jsonb_array_elements_text(case when jsonb_typeof(p_dados -> 'canais') = 'array' then p_dados -> 'canais' else '["chat"]'::jsonb end) x where x in ('chat', 'equipe_contato')), '{}'::text[]) else '{}'::text[] end;
  v_tipo_pac := case when coalesce(c.paciente_tipo, 'proprio') in ('filho', 'outro') then c.paciente_tipo else 'proprio' end;
  select string_agg(distinct p.nome, ' + ') into v_nome from public.catalogo_procedimento p where p.id = any (v_procs);

  insert into public.disponibilidade_pedido (id, conversa_id, pre_agendamento_id, pessoa_chave, paciente_tipo, tipo, procedimentos, procedimento_key, procedimento_nome, plano, unidade, aceita_outras_unidades,
      profissional_preferido, aceita_outros_profissionais, data_ini, data_fim, datas_alternativas, dias_semana, turno, hora_ini, hora_fim, aceita_notificacao, canais, expira_em)
  values (coalesce(p_id, gen_random_uuid()), p_conversa, pa.id, v_pessoa, v_tipo_pac, coalesce(pa.tipo, 'exame'), v_procs, array_to_string(v_procs, ','), left(v_nome, 200), pa.plano, nullif(btrim(p_dados ->> 'unidade'), ''),
      coalesce((p_dados ->> 'aceita_outras_unidades')::boolean, true), nullif(btrim(p_dados ->> 'profissional'), ''), coalesce((p_dados ->> 'aceita_outros_profissionais')::boolean, true), v_ini, v_fim,
      coalesce((p_dados ->> 'datas_alternativas')::boolean, false), v_dias, v_turno, v_hi, v_hf, v_aceita, v_canais, ((v_fim + 1)::timestamp at time zone 'America/Bahia'))
  on conflict (pessoa_chave, tipo, procedimento_key, coalesce(plano, '')) where estado not in ('convertida_em_agendamento', 'expirada', 'cancelada')
  do update set conversa_id = excluded.conversa_id, pre_agendamento_id = excluded.pre_agendamento_id, unidade = excluded.unidade, aceita_outras_unidades = excluded.aceita_outras_unidades,
      profissional_preferido = excluded.profissional_preferido, aceita_outros_profissionais = excluded.aceita_outros_profissionais, data_ini = excluded.data_ini, data_fim = excluded.data_fim,
      datas_alternativas = excluded.datas_alternativas, dias_semana = excluded.dias_semana, turno = excluded.turno, hora_ini = excluded.hora_ini, hora_fim = excluded.hora_fim,
      aceita_notificacao = excluded.aceita_notificacao, canais = excluded.canais, expira_em = excluded.expira_em, ultima_verificacao_em = null
  returning id, (xmax = 0) into v_id, v_novo;
  perform public.disponibilidade_evento_gravar(v_id, case when v_novo then 'criada' else 'editada' end, 'paciente',
      jsonb_build_object('data_ini', v_ini, 'data_fim', v_fim, 'turno', v_turno, 'dias', cardinality(v_dias), 'notificar', v_aceita));
  select * into r from public.disponibilidade_pedido where id = v_id;
  return public.disponibilidade_json(r);
end $function$;

