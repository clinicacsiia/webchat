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
  v_texto text := coalesce((select valor from public.config where chave = 'pedido_sem_horario_texto'), '');
  v_agora timestamp := now() at time zone 'America/Bahia';
  r record; v_lista text[]; v_hor text; v_msg text;
  v_cancelados integer := 0; v_avisos_sem integer := 0; v_avisos_parado integer := 0; v_vistos integer := 0;
begin
  if v_modo not in ('teste', 'ligado') then return jsonb_build_object('modo', 'desligado'); end if;
  if not pg_try_advisory_xact_lock(hashtext('pedido_horario_vigiar')) then return jsonb_build_object('modo', v_modo, 'ocupado', true); end if;
  select coalesce(array_agg(right(t, 8)), '{}') into v_lista
    from regexp_split_to_table(coalesce((select valor from public.config where chave = 'klingo_api_telefones_teste'), ''), '[^0-9]+') t where length(t) >= 8;

  for r in
    select pa.id as pid, pa.conversa_id, pa.conferencia_status, pa.atualizado_em, c.status as cstatus, c.alerta_agenda,
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
        if r.cstatus = 'aguardando' then
          v_msg := replace(v_texto, '{horario}', v_hor);
          update public.pre_agendamentos set status = 'cancelado', conferencia_detalhe = left('Cancelado pelo sistema: ' || case when r.ultimo < v_agora then 'o horário escolhido já passou.' else 'o horário escolhido foi ocupado no Klingo.' end, 300), atualizado_em = now() where id = r.pid and status = 'pronto';
          if found then
            perform public.fluxo_dizer(r.conversa_id, v_msg, null);
            perform public.fluxo_nota(r.conversa_id, 'Pedido cancelado pelo sistema: ' || case when r.ultimo < v_agora then 'o horário escolhido já passou' else 'o horário escolhido foi ocupado no Klingo' end || '. O paciente foi avisado e a conversa encerrada.');
            update public.conversas set status = 'encerrada', encerrada_em = now(), ia_ativa = false, alerta_agenda = null, motivo_encerramento = 'outro', encerramento_origem = 'sistema', atualizado_em = now()
             where id = r.conversa_id and status = 'aguardando';
            v_cancelados := v_cancelados + 1;
          end if;
        else
          -- tem atendente na conversa: ele decide
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
  return jsonb_build_object('modo', v_modo, 'vistos', v_vistos, 'cancelados', v_cancelados, 'avisos_sem_horario', v_avisos_sem, 'avisos_parado', v_avisos_parado);
end $function$;
