-- public.agendamento_reconhecer_klingo(p_aplicar boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agendamento_reconhecer_klingo(p_aplicar boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  r record; v_n integer := 0; v_div integer := 0; v_amb integer := 0; v_ids uuid[] := '{}'; v_upd uuid; v_diverge boolean; v_i integer;
  v_slots jsonb; v_txt text; v_lin text; x record; v_prof text; v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  v_alerta constant text := 'Agendado conforme o Klingo: data, horário, exame ou médico podem estar diferentes do pedido. Confirme com o paciente; estando certo, pode encerrar a conversa.';
begin
  if p_aplicar and coalesce((select valor from public.config where chave = 'agendamento_reconhecer'), 'sim') <> 'sim' then
    return jsonb_build_object('desligado', true);
  end if;
  for r in
    with pre as (
      select pa.id as pre_id, pa.conversa_id, pa.escolha_horario, pa.conferencia_detalhe, c.criado_em as conv_criada,
             public.norm_nome(coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), ct.nome)) as nome_norm
        from public.pre_agendamentos pa
        join public.conversas c on c.id = pa.conversa_id
        join public.contatos ct on ct.id = c.contato_id
       where pa.criado_em > now() - interval '14 days'
         and c.status in ('aguardando', 'em_atendimento')
         and (pa.status = 'pronto' or (pa.status = 'rascunho' and c.status = 'em_atendimento'))
         and jsonb_typeof(pa.escolha_horario) = 'array' and jsonb_array_length(pa.escolha_horario) > 0
    ), ex as (
      select pre.pre_id, pre.conversa_id, pre.escolha_horario, pre.conferencia_detalhe, p.prontuario, e.procedimento, e.unidade,
             (e.agendado_para at time zone 'America/Bahia') as quando
        from pre
        join public.jornada_paciente p on public.norm_nome(p.nome) = pre.nome_norm and p.prontuario not like 'conv:%'
        join public.jornada_card k on k.paciente_chave = p.prontuario and k.arquivado_em is null
        join public.jornada_exame e on e.card_id = k.id and e.status in ('agendado', 'confirmado') and e.agendado_para >= now()
                                   and e.agendado_em >= pre.conv_criada - interval '1 hour'
       where array_length(string_to_array(pre.nome_norm, ' '), 1) >= 2
    )
    select ex.pre_id, ex.conversa_id, (array_agg(ex.escolha_horario))[1] as escolha, (array_agg(ex.conferencia_detalhe))[1] as detalhe,
           count(distinct ex.prontuario) as cadastros,
           jsonb_agg(jsonb_build_object('proc', ex.procedimento, 'unidade', ex.unidade, 'quando', to_char(ex.quando, 'YYYY-MM-DD"T"HH24:MI')) order by ex.quando) as exames
      from ex group by ex.pre_id, ex.conversa_id
  loop
    if r.cadastros > 1 then
      v_amb := v_amb + 1;
      if p_aplicar then
        update public.conversas set alerta_agenda = 'Há mais de um cadastro no Klingo com o nome deste paciente. Confira qual é o agendamento.', atualizado_em = now()
         where id = r.conversa_id and alerta_agenda is distinct from 'Há mais de um cadastro no Klingo com o nome deste paciente. Confira qual é o agendamento.';
      end if;
      continue;
    end if;
    v_n := v_n + 1; v_ids := v_ids || r.pre_id;
    if not p_aplicar then continue; end if;

    v_slots := '[]'::jsonb; v_txt := ''; v_lin := null; v_diverge := false; v_i := 0;
    begin
      for x in select (e ->> 'proc') as proc, (e ->> 'unidade') as unidade, (e ->> 'quando')::timestamp as quando from jsonb_array_elements(r.exames) e loop
        v_i := v_i + 1;
        v_prof := (regexp_match(coalesce(r.detalhe, ''), 'marcado em ' || to_char(x.quando, 'DD/MM HH24:MI') || ' \(([^,)]+),'))[1];
        v_slots := v_slots || jsonb_build_object('data', to_char(x.quando, 'YYYY-MM-DD'), 'hora', to_char(x.quando, 'HH24:MI'), 'min', 30, 'chegada', false, 'grupo', v_i,
                     'unidade', x.unidade, 'profissional', v_prof, 'procedimento', x.proc, 'origem', 'klingo');
        v_lin := '• ' || coalesce(nullif(btrim(x.proc), ''), 'Atendimento') || ': ' || v_dias[extract(dow from x.quando)::int + 1] || ', ' || to_char(x.quando, 'DD/MM') || ' às ' || to_char(x.quando, 'HH24:MI')
                 || coalesce(' — ' || nullif(btrim(x.unidade), ''), '') || coalesce(' — com ' || v_prof, '');
        v_txt := v_txt || case when v_txt = '' then '' else E'\n' end || v_lin;
        if not exists (select 1 from jsonb_array_elements(r.escolha) s
                        where (s ->> 'data')::date = x.quando::date
                          and (coalesce((s ->> 'chegada')::boolean, false) or abs(extract(epoch from ((s ->> 'data')::date + (s ->> 'hora')::time) - x.quando)) <= 1800)
                          and (v_prof is null or public.norm_nome(s ->> 'profissional') = public.norm_nome(v_prof) or public.norm_nome(coalesce(s ->> 'profissional', '')) = ''))
           or (exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = r.conversa_id and i.ativo and nullif(btrim(i.procedimento), '') is not null)
               and not exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = r.conversa_id and i.ativo and nullif(btrim(i.procedimento), '') is not null
                                and (position(public.norm_nome(i.procedimento) in public.norm_nome(x.proc)) > 0 or position(public.norm_nome(x.proc) in public.norm_nome(i.procedimento)) > 0))) then
          v_diverge := true;
        end if;
      end loop;
      update public.pre_agendamentos set status = 'agendado', conferencia_status = 'confirmado', conferencia_detalhe = null, conferencia_via = 'nome', conferencia_em = now(), conferencia_falhas = 0,
             agendado_auto_em = now(), escolha_horario_chat = coalesce(escolha_horario_chat, escolha_horario), escolha_horario = v_slots,
             confirmacao_enviada_em = coalesce(confirmacao_enviada_em, now()), atualizado_em = now()
       where id = r.pre_id and status in ('pronto', 'rascunho') and confirmacao_enviada_em is null
       returning id into v_upd;
      if v_upd is not null then
        insert into public.mensagens (conversa_id, autor, texto)
        values (r.conversa_id, 'agente', left('Boa notícia: sua marcação foi confirmada no sistema da clínica.' || E'\n\nQuando e onde (conforme a agenda da clínica):\n' || v_txt
                 || E'\n\nSe houver preparo, a equipe passa as orientações. Se precisar remarcar ou cancelar, é só responder aqui.', 4000));
        if v_diverge then
          v_div := v_div + 1;
          update public.conversas set alerta_agenda = v_alerta, atualizado_em = now() where id = r.conversa_id and alerta_agenda is distinct from v_alerta;
        end if;
      end if;
    end;
  end loop;
  return jsonb_build_object('aplicado', p_aplicar, 'agendados', v_n, 'com_divergencia_sinalizada', v_div, 'ambiguos', v_amb, 'ids', v_ids);
end $function$;

