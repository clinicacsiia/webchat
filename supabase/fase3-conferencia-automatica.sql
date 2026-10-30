-- Fase 3: conferência automática da marcação no Klingo. JÁ APLICADO no projeto webchat-atendimento (30/10/2026).
--
-- Como funciona:
--   * cron 'agenda-conferir' (a cada 15 s) e 'agenda-revisar' (a cada 10 min) só chamam a Edge Function sync-catalogo-klingo
--     {"agenda":"conferir"} quando há pré-agendamento esperando (agenda_conferencia_ha_trabalho).
--   * A Edge Function pede os alvos (agenda_conferencia_alvos), lê o relatório #7 só dos dias necessários, compara na MEMÓRIA
--     (telefone e nome do paciente x linhas do Klingo) e devolve só o veredito por horário (ok / outro / livre) + um texto curto
--     de divergência. Nome, telefone e prontuário do Klingo nunca são gravados nem escritos em log.
--   * agenda_conferencia_aplicar grava o veredito: status 'agendado' sozinho, alertas, e a mensagem de confirmação ao paciente.
--
-- conferencia_status: null (aguardando) | confirmado | horario_tomado | divergente | nao_encontrado | sumiu | remarcado
-- Sem comandos destrutivos (o drop das duas funções provisórias da primeira versão está comentado no fim, esperando confirmação).

alter table public.agenda_ocupacao add column if not exists primeira_vez timestamptz;   -- sem uso (da primeira versão, que não identificava o paciente)
alter table public.agenda_ocupacao_meta add column if not exists conferindo_ate timestamptz;
alter table public.pre_agendamentos add column if not exists agendado_auto_em timestamptz;
alter table public.pre_agendamentos add column if not exists conferencia_status text
  check (conferencia_status in ('confirmado','horario_tomado','divergente','nao_encontrado','sumiu','remarcado'));
alter table public.pre_agendamentos add column if not exists conferencia_detalhe text;
alter table public.pre_agendamentos add column if not exists conferencia_via text check (conferencia_via in ('telefone','nome','ambos'));
alter table public.pre_agendamentos add column if not exists conferencia_em timestamptz;
alter table public.pre_agendamentos add column if not exists conferencia_falhas integer not null default 0;
alter table public.pre_agendamentos add column if not exists confirmacao_enviada_em timestamptz;
alter table public.conversas add column if not exists alerta_agenda text;

-- ===== Alvos: o que conferir agora =====
-- p_lento = false: só o que mudou há pouco (pronto: 6 h; rascunho: 3 h). p_lento = true: tudo que ainda importa
-- (pronto e rascunho de até 7 dias, e os já confirmados, para perceber cancelamento ou remarcação).
-- p_so_ver = true não pega a trava (usado pelo cron para decidir se vale chamar a função).
create or replace function public.agenda_conferencia_alvos(p_lento boolean default false, p_so_ver boolean default false) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_alvos jsonb; v_dias jsonb; v_hoje date := (now() at time zone 'America/Bahia')::date;
begin
  select coalesce(jsonb_agg(t.alvo order by t.primeiro), '[]'::jsonb) into v_alvos from (
    select jsonb_build_object(
        'id', pa.id, 'status', pa.status, 'conf', pa.conferencia_status,
        'fones', (select coalesce(jsonb_agg(distinct q.f), '[]'::jsonb) from (
                    select right(regexp_replace(x, '\D', '', 'g'), 8) as f
                    from unnest(array[pa.paciente ->> 'celular', pa.paciente ->> 'telefone', ct.telefone]) x
                    where length(regexp_replace(coalesce(x, ''), '\D', '', 'g')) >= 8) q),
        'nomes', (select coalesce(jsonb_agg(distinct q.n), '[]'::jsonb) from (
                    select public.norm_nome(x) as n from unnest(array[pa.paciente ->> 'nome', ct.nome]) x) q where q.n is not null),
        'procs', (select coalesce(jsonb_agg(distinct public.norm_nome(i.procedimento)), '[]'::jsonb)
                  from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and public.norm_nome(i.procedimento) is not null),
        'slots', (select jsonb_agg(jsonb_build_object('idx', s.ord - 1, 'data', s.e ->> 'data', 'hora', s.e ->> 'hora',
                         'prof', coalesce(public.norm_nome(s.e ->> 'profissional'), ''), 'unidade', coalesce(public.norm_nome(s.e ->> 'unidade'), ''),
                         'chegada', coalesce((s.e ->> 'chegada')::boolean, false), 'min', coalesce((s.e ->> 'min')::int, 30)) order by s.ord)
                  from jsonb_array_elements(pa.escolha_horario) with ordinality s(e, ord))
      ) as alvo,
      (select min((e ->> 'data')::date) from jsonb_array_elements(pa.escolha_horario) e) as primeiro
    from public.pre_agendamentos pa
    join public.conversas c on c.id = pa.conversa_id
    join public.contatos ct on ct.id = c.contato_id
    where jsonb_typeof(pa.escolha_horario) = 'array' and jsonb_array_length(pa.escolha_horario) > 0
      and (   (pa.status = 'pronto' and (p_lento or pa.atualizado_em > now() - interval '6 hours'))
           or (pa.status = 'rascunho' and pa.atualizado_em > now() - case when p_lento then interval '7 days' else interval '3 hours' end)
           or (pa.status = 'agendado' and p_lento and pa.conferencia_status in ('confirmado','sumiu','remarcado')))
      and exists (select 1 from jsonb_array_elements(pa.escolha_horario) e where (e ->> 'data')::date >= v_hoje - 1)
  ) t;

  select coalesce(jsonb_agg(d order by d), '[]'::jsonb) into v_dias from (
    select distinct (s ->> 'data') as d from jsonb_array_elements(v_alvos) a, jsonb_array_elements(a -> 'slots') s) q;

  if jsonb_array_length(v_alvos) = 0 then return jsonb_build_object('dias', '[]'::jsonb, 'alvos', '[]'::jsonb); end if;
  if p_so_ver then
    if exists (select 1 from public.agenda_ocupacao_meta where id = 1 and coalesce(conferindo_ate, '-infinity') > now()) then
      return jsonb_build_object('dias', '[]'::jsonb, 'alvos', '[]'::jsonb);
    end if;
  else
    update public.agenda_ocupacao_meta set conferindo_ate = now() + case when p_lento then interval '100 seconds' else interval '45 seconds' end
      where id = 1 and coalesce(conferindo_ate, '-infinity') <= now();
    if not found then return jsonb_build_object('dias', '[]'::jsonb, 'alvos', '[]'::jsonb); end if;
  end if;
  return jsonb_build_object('dias', v_dias, 'alvos', v_alvos);
end $$;
revoke all on function public.agenda_conferencia_alvos(boolean, boolean) from public, anon, authenticated;
grant execute on function public.agenda_conferencia_alvos(boolean, boolean) to service_role;

create or replace function public.agenda_conferencia_ha_trabalho(p_lento boolean default false) returns boolean
language sql security definer set search_path to '' as $$
  select jsonb_array_length(public.agenda_conferencia_alvos(p_lento, true) -> 'alvos') > 0
$$;
revoke all on function public.agenda_conferencia_ha_trabalho(boolean) from public, anon, authenticated;
grant execute on function public.agenda_conferencia_ha_trabalho(boolean) to service_role;

-- ===== Mensagem de confirmação ao paciente (uma vez por pré-agendamento) =====
create or replace function public.pre_enviar_confirmacao(p_pre uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare
  pa public.pre_agendamentos; v_ex text; v_hr text; v_prep text; v_txt text;
  v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
begin
  select * into pa from public.pre_agendamentos where id = p_pre and confirmacao_enviada_em is null for update;
  if not found then return; end if;
  select string_agg('• ' || case i.modalidade when 'RM' then 'Ressonância magnética' when 'TC' then 'Tomografia' when 'US' then 'Ultrassom' when 'RX' then 'Raio-X'
                                  when 'MAMO' then 'Mamografia' when 'DENSITO' then 'Densitometria óssea' else i.modalidade end
        || coalesce(' — ' || i.regiao_nome, '')
        || case i.lado when 'D' then ' (lado direito)' when 'E' then ' (lado esquerdo)' when 'A' then ' (os dois lados)' else '' end
        || ': ' || coalesce(i.procedimento, 'exame a definir') || case when i.quantidade > 1 then ' ×' || i.quantidade else '' end, E'\n' order by i.id)
    into v_ex from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo;
  v_ex := coalesce(v_ex, '• ' || coalesce(pa.procedimento, pa.especialidade, 'Atendimento'));
  select string_agg('• ' || v_dias[extract(dow from (e ->> 'data')::date)::int + 1] || ', ' || to_char((e ->> 'data')::date, 'DD/MM')
        || case when coalesce((e ->> 'chegada')::boolean, false) then ', por ordem de chegada a partir das ' else ' às ' end || (e ->> 'hora')
        || coalesce(' — ' || regexp_replace(e ->> 'unidade', '^CLÍNICA DE SAÚDE E IMAGEM - ', ''), ''), E'\n' order by (e ->> 'data'), (e ->> 'hora'))
    into v_hr from jsonb_array_elements(pa.escolha_horario) e;
  select string_agg('• ' || p.nome || ': ' || case when length(btrim(p.preparo)) > 1200 then left(btrim(p.preparo), 1200) || ' […] (a equipe passa o restante)' else btrim(p.preparo) end, E'\n' order by p.nome) into v_prep
    from public.catalogo_procedimento p
    where p.id in (select i.procedimento_id from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and i.procedimento_id is not null)
      and nullif(btrim(p.preparo), '') is not null;
  v_txt := 'Boa notícia: sua marcação foi confirmada no sistema da clínica.' || E'\n\nExames:\n' || v_ex || E'\n\nQuando e onde:\n' || coalesce(v_hr, '—')
    || case when v_prep is not null then E'\n\nPreparo (conforme o cadastro da clínica):\n' || v_prep else E'\n\nSe houver preparo, a equipe passa as orientações.' end
    || E'\n\nSe precisar remarcar ou cancelar, é só responder aqui.';
  insert into public.mensagens (conversa_id, autor, texto) values (pa.conversa_id, 'agente', left(v_txt, 4000));
  update public.pre_agendamentos set confirmacao_enviada_em = now() where id = pa.id;
end $$;
revoke all on function public.pre_enviar_confirmacao(uuid) from public, anon, authenticated, service_role;

-- ===== Aplica o veredito da Edge Function =====
-- p_resultados: [{"id": uuid, "slots": [{"idx": 0, "r": "ok"|"outro"|"livre"}], "via": "telefone"|"nome"|"ambos"|null, "div": texto|null}]
create or replace function public.agenda_conferencia_aplicar(p_resultados jsonb) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  e jsonb; s jsonb; it jsonb; pa public.pre_agendamentos;
  v_total int; v_ok int; v_outro int; v_passou boolean; v_div text; v_via text; v_ini timestamp;
  v_conf text; v_det text; v_alerta text; v_falhas int;
  v_agora timestamp := now() at time zone 'America/Bahia';
  v_confirmados int := 0; v_alertas int := 0; v_req int;
begin
  if p_resultados is not null and jsonb_typeof(p_resultados) = 'array' then
    for e in select x from jsonb_array_elements(p_resultados) x loop
      begin
        select * into pa from public.pre_agendamentos where id = nullif(e ->> 'id', '')::uuid for update skip locked;
        if not found or jsonb_typeof(pa.escolha_horario) <> 'array' then continue; end if;
        v_total := 0; v_ok := 0; v_outro := 0; v_passou := false;
        for s in select x from jsonb_array_elements(case when jsonb_typeof(e -> 'slots') = 'array' then e -> 'slots' else '[]'::jsonb end) x loop
          it := pa.escolha_horario -> (s ->> 'idx')::int;
          if it is null then continue; end if;
          v_total := v_total + 1;
          if s ->> 'r' = 'ok' then
            v_ok := v_ok + 1;
          else
            if s ->> 'r' = 'outro' then v_outro := v_outro + 1; end if;
            v_ini := case when coalesce((it ->> 'chegada')::boolean, false) then ((it ->> 'data')::date + 1)::timestamp
                          else (it ->> 'data')::date + (it ->> 'hora')::time + make_interval(mins => coalesce((it ->> 'min')::int, 30) + 60) end;
            if v_ini < v_agora then v_passou := true; end if;
          end if;
        end loop;
        if v_total = 0 then continue; end if;
        -- só confirma quando todos os horários que o pedido exige (um por grupo de exame/sala) foram escolhidos
        v_req := null;
        begin
          if not exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and i.procedimento_id is null) then
            select jsonb_array_length(public.agenda_grupos(array_agg(i.procedimento_id order by i.id))) into v_req
            from public.pre_agendamento_itens i, lateral generate_series(1, i.quantidade) g
            where i.conversa_id = pa.conversa_id and i.ativo and i.procedimento_id is not null;
          end if;
        exception when others then v_req := null;
        end;
        if v_req is not null and v_total < v_req then continue; end if;
        v_div := left(nullif(btrim(coalesce(e ->> 'div', '')), ''), 300);
        v_via := case when e ->> 'via' in ('telefone','nome','ambos') then e ->> 'via' end;
        v_conf := null; v_det := null; v_alerta := null; v_falhas := 0;

        if v_ok = v_total then
          v_conf := 'confirmado';
        elsif pa.status = 'agendado' then
          if v_passou then continue; end if;
          if v_div is not null then
            v_conf := 'remarcado'; v_det := v_div; v_alerta := 'Marcação remarcada no Klingo';
          elsif coalesce(pa.conferencia_falhas, 0) + 1 >= 2 then
            v_conf := 'sumiu'; v_falhas := 2; v_alerta := 'Marcação sumiu do Klingo';
            v_det := 'A marcação deixou de aparecer na agenda do Klingo (cancelada ou remarcada?). Confira com o paciente.';
          else
            update public.pre_agendamentos set conferencia_falhas = coalesce(conferencia_falhas, 0) + 1 where id = pa.id;
            continue;
          end if;
        else
          if v_div is not null then
            v_conf := 'divergente'; v_det := v_div; v_alerta := 'Marcação diferente do que foi escolhido';
          elsif v_outro > 0 then
            v_conf := 'horario_tomado'; v_alerta := 'Horário ocupado no Klingo';
            v_det := 'O horário escolhido foi ocupado no Klingo por uma marcação que não bate com este paciente (outro nome ou telefone?). Confira ou ofereça outro horário.';
          elsif v_passou then
            v_conf := 'nao_encontrado'; v_alerta := 'Marcação não apareceu no Klingo';
            v_det := 'O horário escolhido já passou e nenhuma marcação deste paciente apareceu no Klingo.';
          end if;
        end if;

        if v_conf = 'confirmado' then
          if pa.status in ('rascunho','pronto') then
            update public.pre_agendamentos set status = 'agendado', conferencia_status = 'confirmado', conferencia_detalhe = null, conferencia_via = v_via,
              conferencia_em = now(), conferencia_falhas = 0, agendado_auto_em = now(), atualizado_em = now() where id = pa.id;
            perform public.pre_enviar_confirmacao(pa.id);
            v_confirmados := v_confirmados + 1;
          elsif pa.conferencia_status is distinct from 'confirmado' or coalesce(pa.conferencia_falhas, 0) <> 0 then
            update public.pre_agendamentos set conferencia_status = 'confirmado', conferencia_detalhe = null, conferencia_em = now(), conferencia_falhas = 0 where id = pa.id;
          end if;
        elsif pa.conferencia_status is distinct from v_conf or pa.conferencia_detalhe is distinct from v_det then
          update public.pre_agendamentos set conferencia_status = v_conf, conferencia_detalhe = v_det, conferencia_em = now(), conferencia_falhas = v_falhas where id = pa.id;
        end if;
        if v_alerta is not null then v_alertas := v_alertas + 1; end if;
        update public.conversas set alerta_agenda = v_alerta, atualizado_em = now() where id = pa.conversa_id and alerta_agenda is distinct from v_alerta;
      exception when others then
        raise warning 'agenda_conferencia_aplicar: % (%)', sqlerrm, e ->> 'id';
      end;
    end loop;
  end if;
  update public.agenda_ocupacao_meta set conferindo_ate = null where id = 1;
  return jsonb_build_object('confirmados', v_confirmados, 'alertas', v_alertas);
end $$;
revoke all on function public.agenda_conferencia_aplicar(jsonb) from public, anon, authenticated;
grant execute on function public.agenda_conferencia_aplicar(jsonb) to service_role;

-- Libera a trava se a Edge Function falhar no meio.
create or replace function public.agenda_conferencia_liberar() returns void
language sql security definer set search_path to '' as $$ update public.agenda_ocupacao_meta set conferindo_ate = null where id = 1 $$;
revoke all on function public.agenda_conferencia_liberar() from public, anon, authenticated;
grant execute on function public.agenda_conferencia_liberar() to service_role;

-- PENDENTE (precisa de confirmação humana, por ser um drop): remover as duas funções provisórias da primeira versão, hoje sem uso:
--   drop function if exists public.agenda_conferir_pre_agendamentos();
--   drop function if exists public.agenda_conferencia_iniciar(boolean);

-- ===== chat_pedido_salvar: pedido concluído não é trocado; trocar o pedido apaga o horário escolhido antes =====
do $$
declare d text; d2 text;
begin
  d := pg_get_functiondef('public.chat_pedido_salvar(uuid,text,jsonb)'::regprocedure);
  if position('Este pedido já foi concluído' in d) = 0 then
    d2 := replace(d, 'update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;',
      E'if exists (select 1 from public.pre_agendamentos where conversa_id = p_conversa and status in (''agendado'',''cancelado'')) then\n    raise exception ''Este pedido já foi concluído. Inicie um novo atendimento para outro exame.'' using errcode = ''22023'';\n  end if;\n  update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null,\n    etapa = case when etapa in (''dados'',''confirmacao'') then ''data_hora'' else etapa end\n    where conversa_id = p_conversa and escolha_horario is not null;\n  update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;');
    if d2 = d then raise exception 'chat_pedido_salvar: substituição não aplicada'; end if;
    execute d2;
  end if;
end $$;

-- ===== Crons (UTC) =====
select cron.unschedule(jobid) from cron.job where jobname in ('agenda-conferir', 'agenda-revisar');   -- não falha se ainda não existirem
select cron.schedule('agenda-conferir', '15 seconds', $job$
  select net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := '{"agenda":"conferir"}'::jsonb, timeout_milliseconds := 40000)
  where public.agenda_conferencia_ha_trabalho(false);
$job$);
select cron.schedule('agenda-revisar', '*/10 * * * *', $job$
  select net.http_post(
    url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')),
    body := '{"agenda":"conferir","lento":true}'::jsonb, timeout_milliseconds := 100000)
  where public.agenda_conferencia_ha_trabalho(true);
$job$);
