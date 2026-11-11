-- Definição que estava na PRODUÇÃO até 11/11/2026 10:23 UTC, ANTES da correção da auditoria.
-- Guardada só para o teste (testes/sql-producao.test.mjs) reproduzir o defeito antes de aplicar a correção. NÃO aplicar no banco.
CREATE OR REPLACE FUNCTION public.jornada_conversas_sincronizar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_saida   jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('jornada_conversas_sincronizar'));

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
    if not exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = r.conversa_id) and nullif(trim(r.pre_proc), '') is not null then
      insert into public.jornada_exame as e (card_id, marcacao_id, procedimento, unidade, status) values (v_id, 'pre:' || r.pre_id, trim(r.pre_proc), v_unid, 'pedido')
      on conflict (marcacao_id) do update set procedimento = excluded.procedimento, atualizado_em = now() where e.procedimento is distinct from excluded.procedimento;
    end if;

    v_res := public.jornada_aplicar_chat(v_id, v_alvo, jsonb_build_object('fonte', 'chat'));
    if v_res = 'moveu' then n_movidos := n_movidos + 1; end if;
  end loop;

  update public.jornada_card
     set arquivado_em = now(), atualizado_em = now()
   where arquivado_em is null and paciente_chave like 'conv:%'
     and ((coluna in ('agendado', 'perdido') and coluna_desde < now() - interval '3 days') or data_ref < (now() at time zone 'America/Sao_Paulo')::date - 30);
  get diagnostics n_arquiv = row_count;

  v_saida := jsonb_build_object('cartoes_criados', n_criados, 'cartoes_movidos', n_movidos, 'arquivados', n_arquiv);
  update public.jornada_sync_estado set chat_em = now(), chat_resultado = v_saida where id;
  return v_saida;
end;
$function$;
