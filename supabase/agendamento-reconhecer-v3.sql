-- FLUXOGRAMA: entrada (a cada 10 minutos o banco chama a Edge Function klingo-reconhecer, que lê do Klingo as marcações CRIADAS desde a conversa mais antiga e compara, na memória, NOME COMPLETO e EXAME com os pedidos do chat ainda sem agendamento — de conversas abertas OU já encerradas — e devolve só o veredito) -> validação (a marcação precisa ter sido feita DEPOIS que a conversa começou; precisa estar aberta; o exame precisa bater com o pedido; um mesmo agendamento não vale para dois pedidos; dois cadastros com o mesmo nome = ambíguo, nada é escolhido) -> lógica (o pedido vira AGENDADO com a data, hora e unidade REAIS do Klingo (a do chat era previsão, que fica guardada); conversa aberta recebe a mensagem de confirmação; se data, hora ou exame diferem do pedido, só SINALIZA para a atendente confirmar e encerrar) -> saída (pedido agendado, mensagem, alerta e contagens sem dado de paciente).
-- Versão 3.0 — 10/11/2026 / Mudança: substitui a v2 (que só olhava o que a Jornada já tinha lido, limitado pela data do exame): lê direto as marcações CRIADAS no Klingo, então acha agendamentos de qualquer data futura e de conversas já encerradas.
-- Pré-requisitos: fase3-conferencia-automatica.sql (colunas conferencia_*), agendamento-reconhecer.sql (v2: coluna escolha_horario_chat e chave agendamento_reconhecer), pessoa-unica.sql (conversa_exame_aberto etc.). Aditivo e idempotente. Nenhum comando destrutivo.
-- Conversa ENCERRADA: o pedido é marcado como agendado, mas o paciente NÃO recebe mensagem (a menos que config.agendamento_reconhecer_msg_encerradas = 'sim'): quem marcou foi a recepção e a conversa já terminou.
-- O médico não vem do relatório #13825; ele só aparece na mensagem quando a conferência automática já guardou "marcado em DD/MM HH:MM (MÉDICO, UNIDADE)" para o mesmo dia e horário.
-- TESTAR SEM GRAVAR: POST na função klingo-reconhecer com {"aplicar": false}; ou select public.agendamento_reconhecer_alvos();
-- DESLIGAR: update public.config set valor = 'nao' where chave = 'agendamento_reconhecer';   ou   select cron.unschedule('agendamento-reconhecer-klingo');
-- DESFAZER UM CASO: a previsão do chat fica em pre_agendamentos.escolha_horario_chat; no painel, Pré-agendamento > "Voltar para pronto" (ou Cancelar). Para liberar a marcação do Klingo: update pre_agendamentos set klingo_marcacoes = null where id = ...

insert into public.config (chave, valor) values ('agendamento_reconhecer', 'nao'), ('agendamento_reconhecer_msg_encerradas', 'nao') on conflict (chave) do nothing;
alter table public.pre_agendamentos add column if not exists escolha_horario_chat jsonb;
alter table public.pre_agendamentos add column if not exists klingo_marcacoes text[];
comment on column public.pre_agendamentos.klingo_marcacoes is 'Ids das marcações do Klingo reconhecidas para este pedido (cada marcação vale para um pedido só).';

-- ===== Pedidos que ainda precisam ser reconhecidos (só a função de serviço lê; tem nome e telefone) =====
create or replace function public.agendamento_reconhecer_alvos(p_dias integer default 14) returns jsonb
language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', pa.id, 'conv_criada', c.criado_em, 'conv_status', c.status,
      'nome', coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), ct.nome),
      'fones', array(select distinct right(d, 8) from (select regexp_replace(coalesce(x, ''), '\D', '', 'g') as d
                                                        from unnest(array[ct.telefone, pa.paciente ->> 'celular', pa.paciente ->> 'telefone']) x) q where length(d) >= 8),
      'itens', coalesce((select jsonb_agg(i.procedimento order by i.id) from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and nullif(btrim(i.procedimento), '') is not null),
                        case when nullif(btrim(pa.procedimento), '') is not null then jsonb_build_array(pa.procedimento) else '[]'::jsonb end))), '[]'::jsonb)
    from public.pre_agendamentos pa
    join public.conversas c on c.id = pa.conversa_id
    join public.contatos ct on ct.id = c.contato_id
   where pa.criado_em > now() - make_interval(days => least(greatest(coalesce(p_dias, 14), 1), 30))
     and pa.klingo_marcacoes is null
     and pa.status in ('pronto', 'rascunho')
     and (c.status in ('em_atendimento', 'encerrada') or (c.status = 'aguardando' and pa.status = 'pronto'))
     and (exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and nullif(btrim(i.procedimento), '') is not null) or nullif(btrim(pa.procedimento), '') is not null)
$$;
revoke all on function public.agendamento_reconhecer_alvos(integer) from public, anon, authenticated;
grant execute on function public.agendamento_reconhecer_alvos(integer) to service_role;

-- ===== Aplica o veredito da Edge Function =====
-- p_resultados: [{"id": uuid, "identidade": "forte"|"medio"|null, "ambiguo": bool,
--                 "marcacoes": [{"id": "...", "proc": "...", "unidade": "...", "para": "2026-12-02 08:00:00", "em": "2026-11-09 09:57:00", "compat": "exato"|"familia"}]}]
create or replace function public.agendamento_reconhecer_aplicar(p_resultados jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
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
  -- Quando dois pedidos da mesma pessoa casam com a MESMA marcação, vale o pedido concluído ("pronto") e, entre iguais, o mais recente.
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
      -- cada marcação do Klingo vale para UM pedido só
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
end $$;
revoke all on function public.agendamento_reconhecer_aplicar(jsonb) from public, anon, authenticated;
grant execute on function public.agendamento_reconhecer_aplicar(jsonb) to service_role;

-- ===== Rotina: chama a Edge Function (só quando a chave está ligada e há pedido esperando) =====
create or replace function public.agendamento_reconhecer_disparar() returns void
language plpgsql security definer set search_path to '' as $$
begin
  if coalesce((select valor from public.config where chave = 'agendamento_reconhecer'), 'nao') <> 'sim' then return; end if;
  if jsonb_array_length(public.agendamento_reconhecer_alvos(14)) = 0 then return; end if;
  perform net.http_post(url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/klingo-reconhecer',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := '{"aplicar":true,"dias":14}'::jsonb, timeout_milliseconds := 100000);
end $$;
revoke all on function public.agendamento_reconhecer_disparar() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'cron' and p.proname = 'schedule') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'agendamento-reconhecer';   -- a v2 (só olhava a Jornada) sai de cena
    perform cron.schedule('agendamento-reconhecer-klingo', '*/10 * * * *', 'select public.agendamento_reconhecer_disparar()');
  end if;
end $$;
