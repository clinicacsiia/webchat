-- public.agendamento_reconhecer_aplicar(p_resultados jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agendamento_reconhecer_aplicar(p_resultados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  e jsonb; m jsonb; pa public.pre_agendamentos; v_conv_status text; v_ids text[]; v_slots jsonb; v_txt text; v_diverge boolean; v_i integer; v_prof text; v_det text; v_quando timestamp; v_upd uuid;
  v_ag integer := 0; v_ag_abertas integer := 0; v_ag_encerradas integer := 0; v_div integer := 0; v_amb integer := 0; v_ja integer := 0; v_msg integer := 0;
  v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  v_alerta constant text := 'Agendado conforme o Klingo: data, horário, exame ou médico podem estar diferentes do pedido. Confirme com o paciente; estando certo, pode encerrar a conversa.';
  v_alerta_amb constant text := 'Há mais de um cadastro (ou mais de um exame parecido) no Klingo para este paciente. Confira qual é o agendamento.';
  v_msg_enc boolean := coalesce((select valor from public.config where chave = 'agendamento_reconhecer_msg_encerradas'), 'nao') = 'sim';
begin
  if coalesce((select valor from public.config where chave = 'agendamento_reconhecer'), 'nao') <> 'sim' then return jsonb_build_object('desligado', true); end if;
  if p_resultados is null or jsonb_typeof(p_resultados) <> 'array' then return jsonb_build_object('agendados', 0); end if;
  for e in select v.x from jsonb_array_elements(p_resultados) v(x)
             left join public.pre_agendamentos o on o.id = case when v.x ->> 'id' ~ '^[0-9a-f-]{36}$' then (v.x ->> 'id')::uuid end
            order by (o.status = 'pronto') desc nulls last, o.criado_em desc nulls last loop
    begin
      select * into pa from public.pre_agendamentos where id = nullif(e ->> 'id', '')::uuid and status in ('pronto', 'rascunho') and klingo_marcacoes is null for update skip locked;
      if not found then continue; end if;
      select status into v_conv_status from public.conversas where id = pa.conversa_id;
      if coalesce((e ->> 'ambiguo')::boolean, false) then
        v_amb := v_amb + 1;
        if v_conv_status <> 'encerrada' then
          update public.conversas set alerta_agenda = v_alerta_amb, atualizado_em = now() where id = pa.conversa_id and alerta_agenda is distinct from v_alerta_amb;
        end if;
        continue;
      end if;
      if jsonb_typeof(e -> 'marcacoes') <> 'array' or jsonb_array_length(e -> 'marcacoes') = 0 or coalesce(e ->> 'identidade', '') not in ('forte', 'medio') then continue; end if;
      select array_agg(x ->> 'id') into v_ids from jsonb_array_elements(e -> 'marcacoes') x;
      if exists (select 1 from public.pre_agendamentos o where o.id <> pa.id and o.klingo_marcacoes && v_ids) then v_ja := v_ja + 1; continue; end if;

      v_slots := '[]'::jsonb; v_txt := ''; v_diverge := false; v_i := 0;
      for m in select x from jsonb_array_elements(e -> 'marcacoes') x loop
        v_i := v_i + 1;
        v_quando := (m ->> 'para')::timestamp;
        v_prof := (regexp_match(coalesce(pa.conferencia_detalhe, ''), 'marcado em ' || to_char(v_quando, 'DD/MM HH24:MI') || ' \(([^,)]+),'))[1];
        v_slots := v_slots || jsonb_build_object('data', to_char(v_quando, 'YYYY-MM-DD'), 'hora', to_char(v_quando, 'HH24:MI'), 'min', 30, 'chegada', false, 'grupo', v_i,
                     'unidade', nullif(btrim(m ->> 'unidade'), ''), 'profissional', v_prof, 'procedimento', m ->> 'proc', 'origem', 'klingo');
        v_txt := v_txt || case when v_txt = '' then '' else E'\n' end || '• ' || coalesce(nullif(btrim(m ->> 'proc'), ''), 'Atendimento') || ': ' || v_dias[extract(dow from v_quando)::int + 1] || ', '
                 || to_char(v_quando, 'DD/MM') || ' às ' || to_char(v_quando, 'HH24:MI') || coalesce(' — ' || nullif(btrim(m ->> 'unidade'), ''), '') || coalesce(' — com ' || v_prof, '');
        if m ->> 'compat' <> 'exato'
           or not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(pa.escolha_horario) = 'array' then pa.escolha_horario else '[]'::jsonb end) s
                           where (s ->> 'data')::date = v_quando::date
                             and (coalesce((s ->> 'chegada')::boolean, false) or abs(extract(epoch from ((s ->> 'data')::date + (s ->> 'hora')::time) - v_quando)) <= 1800)) then
          v_diverge := true;
        end if;
      end loop;
      v_det := case when v_diverge then 'Data, horário ou exame do Klingo diferem do que foi pedido no chat. Valem os dados do Klingo; confirme com o paciente.' else null end;
      update public.pre_agendamentos set status = 'agendado', conferencia_status = case when v_diverge then 'remarcado' else 'confirmado' end, conferencia_detalhe = v_det,
             conferencia_via = case when e ->> 'identidade' = 'forte' then 'ambos' else 'nome' end, conferencia_em = now(), conferencia_falhas = 0, agendado_auto_em = now(),
             escolha_horario_chat = coalesce(escolha_horario_chat, escolha_horario), escolha_horario = v_slots, klingo_marcacoes = v_ids,
             confirmacao_enviada_em = coalesce(confirmacao_enviada_em, now()), atualizado_em = now()
       where id = pa.id returning id into v_upd;
      if v_upd is null then continue; end if;
      v_ag := v_ag + 1;
      if v_conv_status = 'encerrada' then v_ag_encerradas := v_ag_encerradas + 1; else v_ag_abertas := v_ag_abertas + 1; end if;
      if v_diverge then v_div := v_div + 1; end if;
      if v_conv_status <> 'encerrada' or v_msg_enc then
        insert into public.mensagens (conversa_id, autor, texto)
        values (pa.conversa_id, 'agente', left('Boa notícia: sua marcação foi confirmada no sistema da clínica.' || E'\n\nQuando e onde (conforme a agenda da clínica):\n' || v_txt
                 || E'\n\nSe houver preparo, a equipe passa as orientações. Se precisar remarcar ou cancelar, é só responder aqui.', 4000));
        v_msg := v_msg + 1;
      end if;
      if v_diverge and v_conv_status <> 'encerrada' then
        update public.conversas set alerta_agenda = v_alerta, atualizado_em = now() where id = pa.conversa_id and alerta_agenda is distinct from v_alerta;
      end if;
    exception when others then
      raise warning 'agendamento_reconhecer_aplicar: % (%)', sqlerrm, e ->> 'id';
    end;
  end loop;
  return jsonb_build_object('agendados', v_ag, 'em_conversa_aberta', v_ag_abertas, 'em_conversa_encerrada', v_ag_encerradas, 'com_divergencia_sinalizada', v_div, 'ambiguos', v_amb, 'ja_usadas_por_outro_pedido', v_ja, 'mensagens_enviadas', v_msg);
end $function$;

