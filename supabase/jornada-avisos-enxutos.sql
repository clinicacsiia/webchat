-- FLUXOGRAMA: entrada (a rotina de 1 minuto jornada_vigiar copia cada conversa do chat para o quadro da Jornada) -> validação (o aviso de tempo real só sai se uma linha foi REALMENTE criada ou mudou; comando que não cria nem muda nada não avisa) -> lógica (durante a cópia os gatilhos ficam calados e a rotina manda 1 único aviso no fim, só se algo mudou) -> saída (broadcast "jornada_mudou" no canal fila-chegada: de ~194 mil por dia para poucas dezenas)
-- Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial (auditoria de 11/11/2026)
-- APLICADO NA PRODUÇÃO em 11/11/2026 (migrações auditoria_1111_*) e conferido lá. Resultado medido: docs/auditoria-2026-11-11.md.
--
-- O QUE ESTAVA ERRADO (medido na produção em 10/11/2026):
--   * 193.461 avisos "jornada_mudou" num dia, em rajadas de ~166 no mesmo segundo, uma vez por minuto.
--   * Causa: jornada_conversas_sincronizar() faz 1 "insert ... on conflict" POR CONVERSA a cada minuto, e o gatilho de INSERT
--     (jornada_exame_tr_ins) avisava a cada comando, mesmo quando nenhuma linha nova era criada.
--   * Efeito: 47 MB por dia em realtime.messages (o banco estava em 208 MB de 500 MB), 190 mil chamadas de paciente_jornada e
--     205 mil de fila_minha_vez (cada portal aberto reconsulta a cada aviso).
-- A correção de 07/11 (jornada-tempo-real.sql 1.1) calou só a leitura do Klingo; a cópia das conversas ficou de fora.
--
-- Pré-requisitos: jornada-tempo-real.sql (gatilhos e sinal jornada.sem_aviso) e o módulo Jornada (retrato em supabase/producao/).
-- Aditivo e idempotente (só create or replace). Nenhum dado pessoal sai no aviso.
-- ROLLBACK: reaplicar supabase/producao/funcoes/jornada_avisar_exame_ins.sql e jornada_conversas_sincronizar.sql do retrato de 11/11/2026
--   (commit anterior a esta mudança).

-- ===== PARTE 1: o gatilho de INSERT só avisa se alguma linha foi criada =====
create or replace function public.jornada_avisar_exame_ins() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if coalesce(current_setting('jornada.sem_aviso', true), '') = '1' then return null; end if;
  if not exists (select 1 from n) then return null; end if;   -- "insert ... on conflict" que não criou nada: sem aviso
  begin perform realtime.send(jsonb_build_object('evento', 'jornada_mudou'), 'jornada_mudou', 'fila-chegada', false); exception when others then null; end;
  return null;
end $$;
revoke all on function public.jornada_avisar_exame_ins() from public, anon, authenticated;

-- ===== PARTE 2: a cópia das conversas para o quadro fica calada e manda 1 aviso no fim, só se algo mudou =====
-- Corpo igual ao da produção em 11/11/2026, com três acréscimos marcados com "-- 11/11".
create or replace function public.jornada_conversas_sincronizar() returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  r         record;
  v_chave   text;
  v_id      bigint;
  v_alvo    text;
  v_res     text;
  v_dia     date;
  v_unid    text;
  n_criados integer := 0;
  n_movidos integer := 0;
  n_arquiv  integer := 0;
  n_exames  integer := 0;   -- 11/11: exames criados ou alterados nesta rodada
  n_linha   integer;        -- 11/11
  v_antes   text := coalesce(current_setting('jornada.sem_aviso', true), '');   -- 11/11: quem chamou já tinha pedido silêncio?
  v_saida   jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('jornada_conversas_sincronizar'));
  perform set_config('jornada.sem_aviso', '1', true);   -- 11/11: os gatilhos ficam calados durante a cópia

  for r in
    select distinct on (cv.id)
           cv.id as conversa_id, cv.status as conv_status, cv.criado_em,
           coalesce(nullif(trim(cv.paciente_nome), ''), nullif(trim(cv.nome_informado), ''), nullif(trim(ct.nome), '')) as nome,
           coalesce(nullif(pre.unidade, 'Tanto faz'), nullif(cv.unidade_inicial, ''), '') as unidade,
           pre.id as pre_id, pre.status as pre_status, pre.etapa as pre_etapa, pre.procedimento as pre_proc
    from public.conversas cv
    join public.pre_agendamentos pre on pre.conversa_id = cv.id
    left join public.contatos ct on ct.id = cv.contato_id
    where cv.criado_em > now() - interval '14 days' or cv.status <> 'encerrada'
    order by cv.id, pre.atualizado_em desc
  loop
    v_chave := 'conv:' || r.conversa_id;
    v_dia := (r.criado_em at time zone 'America/Sao_Paulo')::date;
    v_unid := public.jornada_unidade_curta(r.unidade);
    v_alvo := public.jornada_coluna_do_chat(r.pre_status, r.pre_etapa, r.conv_status);

    insert into public.jornada_paciente as p (prontuario, nome) values (v_chave, r.nome)
    on conflict (prontuario) do update set nome = coalesce(excluded.nome, p.nome), atualizado_em = now() where p.nome is distinct from coalesce(excluded.nome, p.nome);

    select id into v_id from public.jornada_card where paciente_chave = v_chave and data_ref = v_dia and unidade = v_unid;
    if v_id is null then
      insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna, conversa_id) values (v_chave, v_dia, v_unid, v_alvo, r.conversa_id)
      on conflict (paciente_chave, data_ref, unidade) do nothing returning id into v_id;
      if v_id is not null then
        insert into public.jornada_evento (card_id, tipo, origem, para_coluna, detalhe) values (v_id, 'criado', 'sistema', v_alvo, jsonb_build_object('conversa', r.conversa_id));
        n_criados := n_criados + 1;
      else
        select id into v_id from public.jornada_card where paciente_chave = v_chave and data_ref = v_dia and unidade = v_unid;
      end if;
    end if;

    insert into public.jornada_exame as e (card_id, marcacao_id, procedimento, unidade, status)
    select v_id, 'item:' || i.id, coalesce(nullif(trim(i.procedimento), ''), nullif(trim(i.regiao_nome), ''), nullif(trim(i.modalidade), ''), 'Exame'), v_unid,
           case when i.ativo then 'pedido' else 'cancelado' end
    from public.pre_agendamento_itens i where i.conversa_id = r.conversa_id
    on conflict (marcacao_id) do update set procedimento = excluded.procedimento, status = excluded.status, atualizado_em = now()
      where (e.procedimento, e.status) is distinct from (excluded.procedimento, excluded.status);
    get diagnostics n_linha = row_count; n_exames := n_exames + n_linha;   -- 11/11
    if not exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = r.conversa_id) and nullif(trim(r.pre_proc), '') is not null then
      insert into public.jornada_exame as e (card_id, marcacao_id, procedimento, unidade, status) values (v_id, 'pre:' || r.pre_id, trim(r.pre_proc), v_unid, 'pedido')
      on conflict (marcacao_id) do update set procedimento = excluded.procedimento, atualizado_em = now() where e.procedimento is distinct from excluded.procedimento;
      get diagnostics n_linha = row_count; n_exames := n_exames + n_linha;   -- 11/11
    end if;

    v_res := public.jornada_aplicar_chat(v_id, v_alvo, jsonb_build_object('fonte', 'chat'));
    if v_res = 'moveu' then n_movidos := n_movidos + 1; end if;
  end loop;

  update public.jornada_card
     set arquivado_em = now(), atualizado_em = now()
   where arquivado_em is null and paciente_chave like 'conv:%'
     and ((coluna in ('agendado', 'perdido') and coluna_desde < now() - interval '3 days') or data_ref < (now() at time zone 'America/Sao_Paulo')::date - 30);
  get diagnostics n_arquiv = row_count;

  v_saida := jsonb_build_object('cartoes_criados', n_criados, 'cartoes_movidos', n_movidos, 'arquivados', n_arquiv, 'exames_alterados', n_exames);
  update public.jornada_sync_estado set chat_em = now(), chat_resultado = v_saida where id;

  -- 11/11: devolve o silêncio como estava e manda 1 único aviso, só se algo mudou (sem dado pessoal).
  perform set_config('jornada.sem_aviso', v_antes, true);
  if v_antes <> '1' and (n_criados > 0 or n_movidos > 0 or n_arquiv > 0 or n_exames > 0) then
    begin perform realtime.send(jsonb_build_object('evento', 'jornada_mudou'), 'jornada_mudou', 'fila-chegada', false); exception when others then null; end;
  end if;
  return v_saida;
end $$;
revoke all on function public.jornada_conversas_sincronizar() from public, anon, authenticated;
