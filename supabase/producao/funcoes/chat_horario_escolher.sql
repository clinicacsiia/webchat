-- public.chat_horario_escolher(p_conversa uuid, p_token text, p_grupo integer, p_data date, p_hora text, p_unidade text)
-- Pode executar: anon, authenticated, service_role
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

