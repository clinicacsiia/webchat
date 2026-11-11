-- public.chat_horario_escolher(p_conversa uuid, p_token text, p_grupo integer, p_data date, p_hora text, p_unidade text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_horario_escolher(p_conversa uuid, p_token text, p_grupo integer, p_data date, p_hora text, p_unidade text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_procs int[]; v_grupos jsonb; v_g jsonb; v_row record; v_escolhas jsonb; v_outros jsonb; v_novo jsonb; v_total int; v_feitos int; v_txt text; v_msg bigint;
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
  v_grupos := public.agenda_grupos(v_procs);
  v_total := jsonb_array_length(v_grupos);
  v_g := v_grupos -> (greatest(p_grupo, 1) - 1);
  if v_g is null then raise exception 'Grupo inexistente.' using errcode = '22023'; end if;
  select array_agg(x::int) into v_procs from jsonb_array_elements_text(v_g -> 'procs') x;

  select coalesce(escolha_horario, '[]'::jsonb) into v_escolhas from public.pre_agendamentos where conversa_id = p_conversa;
  v_escolhas := coalesce(v_escolhas, '[]'::jsonb);
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_outros from jsonb_array_elements(v_escolhas) e where (e ->> 'grupo')::int <> greatest(p_grupo, 1);

  -- confere de novo agora: o horário pode ter sido ocupado enquanto o paciente decidia
  select * into v_row from public.agenda_horarios(v_procs, p_data, p_data, p_unidade, null, null,
        (select coalesce(jsonb_agg(jsonb_build_object('data', e ->> 'data', 'hora', e ->> 'hora', 'min', coalesce((e ->> 'min')::int, 30), 'unidade', e ->> 'unidade')), '[]'::jsonb) from jsonb_array_elements(v_outros) e))
      h where h.hora = p_hora order by h.profissional limit 1;
  if v_row.hora is null then raise exception 'Esse horário acabou de ficar indisponível. Escolha outro, por favor.' using errcode = 'P0002'; end if;

  v_novo := jsonb_build_object('grupo', greatest(p_grupo, 1), 'data', p_data, 'hora', v_row.hora, 'unidade', v_row.unidade, 'profissional', v_row.profissional,
                               'local', v_row.local, 'min', v_row.duracao_min, 'chegada', v_row.chegada);
  v_escolhas := v_outros || jsonb_build_array(v_novo);
  v_feitos := jsonb_array_length(v_escolhas);

  update public.pre_agendamentos set escolha_horario = v_escolhas,
    data_desejada = (select (e ->> 'data')::date from jsonb_array_elements(v_escolhas) e order by (e ->> 'grupo')::int limit 1),
    hora_desejada = (select e ->> 'hora' from jsonb_array_elements(v_escolhas) e order by (e ->> 'grupo')::int limit 1),
    unidade = coalesce(unidade, v_row.unidade),
    etapa = case when v_feitos >= v_total then 'dados' else 'data_hora' end, atualizado_em = now()
  where conversa_id = p_conversa and status not in ('agendado','cancelado');

  v_txt := format('Escolhi %s, %s/%s%s%s. (Sei que é uma previsão e que o atendente confirma o dia e o horário.)',
    v_dias[extract(dow from p_data)::int + 1], to_char(p_data, 'DD'), to_char(p_data, 'MM'),
    case when v_row.chegada then ', por ordem de chegada a partir das ' || v_row.hora else ' às ' || v_row.hora end,
    case when v_row.unidade is not null then ' — ' || v_row.unidade else '' end);
  if v_total > 1 then v_txt := format('Horário %s de %s: %s', greatest(p_grupo, 1), v_total, v_txt); end if;
  update public.conversas set status = case when status = 'encerrada' then 'aguardando' else status end where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_msg;
  return jsonb_build_object('ok', true, 'restantes', greatest(v_total - v_feitos, 0), 'escolha', v_novo, 'mensagem_id', v_msg);
end $function$;

