-- FLUXOGRAMA: entrada (rotina a cada 5 minutos olha os pedidos "prontos" que esperam a equipe marcar no Klingo, com horário escolhido) -> validação (modo em config.pedido_horario_modo: desligado | teste (só os celulares de klingo_api_telefones_teste) | ligado; pedido pronto, conversa aberta, horário escolhido)
--   -> lógica (A) SEM HORÁRIO = a data/hora escolhida já passou OU o Klingo mostra o horário ocupado por outra marcação (conferencia_status = 'horario_tomado'): se ninguém da equipe está atendendo, cancela o pedido, AVISA O PACIENTE NA HORA e encerra a conversa; se há atendente na conversa, só avisa o atendente
--      (B) HORÁRIO AINDA LIVRE, mas o pedido está parado há config.pedido_parado_horas (24): faixa de aviso na conversa para o atendente marcar ou não
--   -> saída (mensagem ao paciente + pedido "cancelado" + conversa encerrada pelo sistema, ou faixa conversas.alerta_agenda; contagens em jsonb, sem dado de paciente)
-- Versão 1.0 — 13/11/2026 / Mudança: pedido do dono (13/11/2026): pedido sem horário avisa o paciente e encerra; horário antigo ainda livre vira aviso ao atendente.
-- Por que existe: o teste do celular de teste (12/11/2026) deixou pedidos "prontos" sem destino. A conferência já marcava "horario_tomado"/"nao_encontrado", mas ninguém avisava o paciente nem fechava a conversa.
-- Cuidado: "horario_tomado" também acontece quando a equipe marca com outro nome ou telefone. Por isso o aviso ao paciente só sai com a conversa SEM atendente (status 'aguardando') e o modo começa em 'teste'.
-- LIGAR PARA TODOS: update public.config set valor = 'ligado' where chave = 'pedido_horario_modo';
-- DESLIGAR (efeito imediato): update public.config set valor = 'desligado' where chave = 'pedido_horario_modo';  ou  select cron.unschedule('pedido-horario-vigia');
-- ROLLBACK: select cron.unschedule('pedido-horario-vigia'); drop function public.pedido_horario_vigiar(); (a parte 2 repõe a linha original em agenda_conferencia_aplicar: ver o arquivo supabase/producao/funcoes/agenda_conferencia_aplicar.sql)

-- ===== PARTE 1: chaves =====
insert into public.config (chave, valor) values
  ('pedido_horario_modo', 'teste'),
  ('pedido_parado_horas', '24'),
  ('pedido_sem_horario_texto', 'Olá! Infelizmente o horário que você escolheu ({horario}) não está mais disponível e, por isso, o seu pedido foi cancelado. Pedimos desculpas pelo transtorno. Se ainda quiser marcar, abra uma nova conversa e escolha outro horário. Estamos à disposição!')
on conflict (chave) do nothing;

-- ===== PARTE 2: a rotina =====
create or replace function public.pedido_horario_vigiar() returns jsonb
language plpgsql security definer set search_path to '' as $$
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
end $$;
revoke all on function public.pedido_horario_vigiar() from public, anon, authenticated;
grant execute on function public.pedido_horario_vigiar() to service_role;

-- ===== PARTE 3: a conferência da agenda não pode apagar o aviso "Pedido parado" =====
-- Em agenda_conferencia_aplicar, a linha
--   update public.conversas set alerta_agenda = v_alerta, atualizado_em = now() where id = pa.conversa_id and alerta_agenda is distinct from v_alerta;
-- passa a ser
--   ... and alerta_agenda is distinct from v_alerta and not (v_alerta is null and alerta_agenda like 'Pedido parado%');
-- (aplicada com o corpo inteiro da função, copiado de supabase/producao/funcoes/agenda_conferencia_aplicar.sql)

-- ===== PARTE 4: rotina =====
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.schedule('pedido-horario-vigia', '*/5 * * * *', 'select public.pedido_horario_vigiar()');
  end if;
end $$;
