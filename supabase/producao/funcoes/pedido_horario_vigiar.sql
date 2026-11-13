-- public.pedido_horario_vigiar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pedido_horario_vigiar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_modo text := coalesce((select valor from public.config where chave = 'pedido_horario_modo'), 'desligado');
  v_horas integer := coalesce(nullif((select valor from public.config where chave = 'pedido_parado_horas'), '')::integer, 24);
  v_agora timestamp := now() at time zone 'America/Bahia';
  r record; v_lista text[]; v_hor text; v_msg text; v_procs int[]; v_slots jsonb; v_s1 jsonb; v_s2 jsonb; v_pend jsonb;
  v_ofertas integer := 0; v_calendario integer := 0; v_avisos_sem integer := 0; v_avisos_parado integer := 0; v_vistos integer := 0;
begin
  if v_modo not in ('teste', 'ligado') then return jsonb_build_object('modo', 'desligado'); end if;
  if not pg_try_advisory_xact_lock(hashtext('pedido_horario_vigiar')) then return jsonb_build_object('modo', v_modo, 'ocupado', true); end if;
  select coalesce(array_agg(right(t, 8)), '{}') into v_lista
    from regexp_split_to_table(coalesce((select valor from public.config where chave = 'klingo_api_telefones_teste'), ''), '[^0-9]+') t where length(t) >= 8;

  for r in
    select pa.id as pid, pa.conversa_id, pa.conferencia_status, pa.atualizado_em, c.status as cstatus, c.motor, c.alerta_agenda,
           (select min(((e ->> 'data') || ' ' || coalesce(nullif(e ->> 'hora', ''), '00:00'))::timestamp) from jsonb_array_elements(pa.escolha_horario) e) as primeiro,
           (select max(((e ->> 'data') || ' ' || coalesce(nullif(e ->> 'hora', ''), '23:59'))::timestamp) from jsonb_array_elements(pa.escolha_horario) e) as ultimo,
           right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) as fone
      from public.pre_agendamentos pa
      join public.conversas c on c.id = pa.conversa_id
      join public.contatos ct on ct.id = c.contato_id
     where pa.status = 'pronto' and c.status in ('aguardando', 'em_atendimento')
       and jsonb_typeof(pa.escolha_horario) = 'array' and jsonb_array_length(pa.escolha_horario) > 0
  loop
    begin
      if v_modo = 'teste' and not (r.fone = any (v_lista)) then continue; end if;
      v_vistos := v_vistos + 1;
      v_hor := to_char(r.primeiro, 'DD/MM "às" HH24:MI');

      if r.ultimo < v_agora or r.conferencia_status = 'horario_tomado' then
        -- (A) sem horário
        v_procs := public.fluxo_procs(r.conversa_id);
        if r.cstatus = 'aguardando' and r.motor = 'fluxo' and v_procs is not null and jsonb_array_length(public.agenda_grupos(v_procs)) = 1 then
          -- o assistente oferece o horário livre mais perto do que o paciente tinha escolhido; depois o seguinte, em outro dia se houver
          perform set_config('app.conversa', r.conversa_id::text, true);
          select coalesce(jsonb_agg(to_jsonb(x) - 'ord' order by x.ord), '[]'::jsonb) into v_slots from (
            select h.data, h.hora, h.unidade, h.local, h.profissional, h.duracao_min as min, h.chegada,
                   row_number() over (order by abs(h.data - r.primeiro::date), h.data, h.hora) as ord
              from public.agenda_horarios(v_procs, current_date, current_date + 30, null, null, null, '[]'::jsonb) h
             where h.data >= current_date and (h.data + h.hora::time) > r.primeiro) x;
          -- (acima: nunca oferece o próprio horário perdido; se não houver nada depois dele, tenta qualquer horário livre)
          if jsonb_array_length(v_slots) = 0 then
            select coalesce(jsonb_agg(to_jsonb(x) - 'ord' order by x.ord), '[]'::jsonb) into v_slots from (
              select h.data, h.hora, h.unidade, h.local, h.profissional, h.duracao_min as min, h.chegada,
                     row_number() over (order by h.data, h.hora) as ord
                from public.agenda_horarios(v_procs, current_date, current_date + 30, null, null, null, '[]'::jsonb) h
               where not (h.data = r.primeiro::date and h.hora = to_char(r.primeiro, 'HH24:MI'))) x;
          end if;
          -- o segundo horário prefere outro dia
          v_s1 := v_slots -> 0;
          if v_s1 is not null then
            select s into v_s2 from jsonb_array_elements(v_slots) with ordinality t(s, ord) where ord > 1 order by (s ->> 'data' = v_s1 ->> 'data'), ord limit 1;
            v_slots := case when v_s2 is null then jsonb_build_array(v_s1) else jsonb_build_array(v_s1, v_s2) end;
          end if;

          update public.pre_agendamentos set status = 'rascunho', escolha_horario = null, data_desejada = null, hora_desejada = null, etapa = 'data_hora',
                 conferencia_status = null, conferencia_detalhe = null, atualizado_em = now()
           where id = r.pid and status = 'pronto';
          if found then
            update public.conversas set ia_ativa = true, alerta_agenda = null, atualizado_em = now() where id = r.conversa_id and status = 'aguardando';
            if v_s1 is not null then
              v_pend := jsonb_build_object('n', 1, 'original', v_hor, 'slots', v_slots, 'texto', public.pedido_oferta_texto(v_s1, 1, v_hor));
              perform public.fluxo_set(r.conversa_id, jsonb_build_object('oferta_pendente', v_pend, 'confirmado', true, 'sem_horario', false));
              perform public.fluxo_nota(r.conversa_id, 'Horário escolhido (' || v_hor || ') não vale mais: o assistente ofereceu ao paciente o horário mais próximo disponível.');
              perform public.fluxo_perguntar(r.conversa_id, 'horario_oferta', null);
              v_ofertas := v_ofertas + 1;
            else
              perform public.fluxo_set(r.conversa_id, jsonb_build_object('oferta_pendente', null, 'confirmado', false, 'sem_horario', false));
              perform public.fluxo_nota(r.conversa_id, 'Horário escolhido (' || v_hor || ') não vale mais e não há outro livre nos próximos 30 dias: o assistente pediu ao paciente que escolha data e hora.');
              perform public.fluxo_perguntar(r.conversa_id, 'horario', coalesce((select valor from public.config where chave = 'pedido_escolha_texto'), ''));
              v_calendario := v_calendario + 1;
            end if;
          end if;
        else
          -- tem atendente na conversa (ou o pedido não cabe no assistente): ele decide
          v_msg := left('Pedido sem horário: ' || case when r.ultimo < v_agora then 'a data escolhida (' || v_hor || ') já passou.' else 'o horário escolhido (' || v_hor || ') aparece ocupado no Klingo.' end || ' Avisar o paciente e combinar outro, ou cancelar o pedido.', 300);
          if r.alerta_agenda is distinct from v_msg then
            update public.conversas set alerta_agenda = v_msg, atualizado_em = now() where id = r.conversa_id; v_avisos_sem := v_avisos_sem + 1;
          end if;
        end if;
      elsif r.atualizado_em < now() - make_interval(hours => v_horas) then
        -- (B) horário ainda livre, pedido parado: o atendente decide marcar ou não
        v_msg := left('Pedido parado há mais de ' || v_horas || ' h: o horário escolhido (' || v_hor || ') ainda está livre. Marcar ou não?', 300);
        if r.alerta_agenda is null or r.alerta_agenda like 'Pedido parado%' then
          if r.alerta_agenda is distinct from v_msg then
            update public.conversas set alerta_agenda = v_msg, atualizado_em = now() where id = r.conversa_id; v_avisos_parado := v_avisos_parado + 1;
          end if;
        end if;
      end if;
    exception when others then
      raise warning 'pedido_horario_vigiar: % (%)', sqlerrm, r.pid;
    end;
  end loop;
  return jsonb_build_object('modo', v_modo, 'vistos', v_vistos, 'ofertas', v_ofertas, 'pediu_calendario', v_calendario, 'avisos_sem_horario', v_avisos_sem, 'avisos_parado', v_avisos_parado);
end $function$
;
