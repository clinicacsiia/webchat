-- ROLLBACK de supabase/pedido-marcacao-klingo.sql
-- Versão 1.0 — 16/11/2026 / Mudança: devolve app_pedido_dados e app_pedido_acao como estavam no retrato de 15/11/2026 (hashes da produção: app_pedido_dados da45d886..., app_pedido_acao f874e661...).
-- Só create or replace: roda em qualquer ordem e quantas vezes quiser.

CREATE OR REPLACE FUNCTION public.app_pedido_dados(p_pac uuid, p_conversa uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with hoje as (
    select to_char(now() at time zone 'America/Bahia', 'YYYY-MM-DD') as d
  ), base as (
    select ac.conversa_id, ac.pessoa_nome, ac.eu, ac.visto_sig, c.status as cstatus, c.criado_em, c.atualizado_em, c.encerrada_em, c.motivo_encerramento as motivo,
           c.encerramento_origem as origem, c.primeiro_humano_em, pa.tipo as pre_tipo, pa.status as pre_status,
           pa.procedimento as pre_proc, pa.escolha_horario as pre_hor, pa.unidade as pre_unidade
      from public.app_conversa ac
      join public.conversas c on c.id = ac.conversa_id
      left join public.pre_agendamentos pa on pa.conversa_id = c.id
     where ac.paciente_id = p_pac and (p_conversa is null or ac.conversa_id = p_conversa)
       and (ac.removido_em is null or c.status <> 'encerrada' or c.encerrada_em > ac.removido_em)
  ), jor as (
    select b.conversa_id, e.id as exame_id, e.procedimento as nome, e.unidade,
           case when e.marcacao_id ~ '^m\d+$' then substr(e.marcacao_id, 2) end as voucher,
           case when (e.checkin_em at time zone 'America/Bahia')::date = (e.agendado_para at time zone 'America/Bahia')::date then to_char(e.checkin_em at time zone 'America/Bahia', 'HH24:MI') end as chegada,
           to_char(e.agendado_para at time zone 'America/Bahia', 'YYYY-MM-DD') as data, to_char(e.agendado_para at time zone 'America/Bahia', 'HH24:MI') as hora,
           case when e.status in ('cancelado', 'faltou') or (e.status = 'pedido' and b.pre_status = 'cancelado') then null
                when e.status = 'atendido' then 5
                when e.status = 'pedido' then 1
                when jc.coluna in ('chegou', 'em_atendimento') then 4
                when (e.checkin_em at time zone 'America/Bahia')::date = (e.agendado_para at time zone 'America/Bahia')::date then 4
                when e.status = 'confirmado' or lower(coalesce(e.confirm_status, '')) = 'confirmado' then 3
                else 2 end as ok,
           case when e.status in ('cancelado', 'faltou') then e.status when e.status = 'pedido' and b.pre_status = 'cancelado' then 'cancelado' end as excecao
      from base b
      join public.jornada_card jc on jc.conversa_id = b.conversa_id
      join public.jornada_exame e on e.card_id = jc.id
     where e.status <> 'remarcado'
  ), pre as (
    select b.conversa_id, null::bigint as exame_id, coalesce(nullif(i.procedimento, ''), nullif(b.pre_proc, ''), 'Atendimento') as nome, b.pre_unidade as unidade,
           null::text as voucher, null::text as chegada,
           b.pre_hor -> 0 ->> 'data' as data, b.pre_hor -> 0 ->> 'hora' as hora,
           case b.pre_status when 'agendado' then 2 when 'pronto' then 1 else 0 end as ok,
           case when b.pre_status = 'cancelado' then 'cancelado' end as excecao
      from base b
      left join public.pre_agendamento_itens i on i.conversa_id = b.conversa_id and i.ativo
     where not exists (select 1 from jor j where j.conversa_id = b.conversa_id)
       and b.pre_status in ('rascunho', 'pronto', 'agendado', 'cancelado')
       and (b.pre_status <> 'rascunho' or b.criado_em > now() - interval '14 days')
       and (i.id is not null or b.pre_proc is not null)
  ), todos as (
    select * from jor union all select * from pre
  ), com_res as (
    select t.*, case when t.ok = 5 then coalesce(r.estado, 'aguardando') end as res, r.id as res_id, r.conversa_resultado_id as res_conv
      from todos t
      left join public.app_resultado r on r.paciente_id = p_pac and r.conversa_id = t.conversa_id and t.exame_id is not null and r.exame_id = t.exame_id
  ), por_conversa as (
    select b.*,

           coalesce(jsonb_agg(jsonb_build_object('id', x.exame_id, 'nome', x.nome, 'unidade', x.unidade, 'data', x.data, 'hora', x.hora, 'ok', x.ok, 'excecao', x.excecao, 'voucher', x.voucher, 'chegada', x.chegada,
                                                 'resultado', x.res, 'resultado_id', x.res_id, 'resultado_conversa', x.res_conv)
                             order by (x.data is not null and x.data < (select d from hoje)), case when x.data >= (select d from hoje) then x.data end, x.data desc nulls last, x.hora, x.nome)
                    filter (where x.nome is not null), '[]'::jsonb) as exames,
           md5(coalesce(string_agg(coalesce(x.exame_id::text, 'p') || ':' || coalesce(x.ok::text, 'x') || ':' || coalesce(x.excecao, '') || ':' || coalesce(x.data, '') || coalesce(x.hora, '') || ':' || coalesce(x.res, ''),
                                   '|' order by x.exame_id nulls last, x.nome) filter (where x.ok >= 2 or x.excecao is not null), '')
               || case when b.cstatus = 'encerrada' then '|enc:' || coalesce(b.encerrada_em::text, '') else '' end) as sig,
           min(x.data) filter (where x.excecao is null and x.ok < 5 and x.data >= (select d from hoje)) as proxima,
           coalesce(bool_or(x.ok between 2 and 5), false) as tem_exame_ativo,
           max(x.data) filter (where x.ok between 2 and 4) as ultima_data
      from base b left join com_res x on x.conversa_id = b.conversa_id
     group by b.conversa_id, b.pessoa_nome, b.eu, b.visto_sig, b.cstatus, b.criado_em, b.atualizado_em, b.encerrada_em, b.motivo, b.origem, b.primeiro_humano_em,
              b.pre_tipo, b.pre_status, b.pre_proc, b.pre_hor, b.pre_unidade
  ), pronto as (
    select pc.*,
           case when pc.cstatus = 'encerrada' and pc.encerrada_em is not null
                then greatest(pc.encerrada_em, coalesce(case when pc.ultima_data ~ '^\d{4}-\d{2}-\d{2}$' then pc.ultima_data::date::timestamp at time zone 'America/Bahia' end, pc.encerrada_em)) + interval '30 days' end as apaga_em
      from por_conversa pc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'conversa', conversa_id, 'pessoa', pessoa_nome, 'eu', eu, 'aberta', cstatus <> 'encerrada', 'status', cstatus, 'criado_em', criado_em, 'atualizado_em', atualizado_em,
           'tipo', pre_tipo, 'pre_status', pre_status, 'exames', exames, 'sig', sig, 'novo', visto_sig is not null and visto_sig <> sig,
           'encerrada_em', encerrada_em, 'motivo', motivo, 'origem', origem, 'apaga_em', apaga_em, 'proxima', proxima,
           'pode_reabrir', cstatus = 'encerrada' and origem is distinct from 'paciente' and encerrada_em > now() - interval '30 days',
           'pode_avaliar', cstatus = 'encerrada' and motivo is distinct from 'nao_respondido'
                           and coalesce((select valor from public.config where chave = 'avaliacao_ativa'), 'nao') = 'sim'
                           and exists (select 1 from public.mensagens m where m.conversa_id = pronto.conversa_id and (m.opcoes ->> 'tipo') = 'despedida' and (m.opcoes ->> 'encerrada_em')::timestamptz = pronto.encerrada_em)
                           and not exists (select 1 from public.avaliacao_atendimento a where a.conversa_id = pronto.conversa_id and a.encerrada_em = pronto.encerrada_em),
           'avaliou', cstatus = 'encerrada' and exists (select 1 from public.avaliacao_atendimento a where a.conversa_id = pronto.conversa_id and a.encerrada_em = pronto.encerrada_em),
           'pode_apagar', cstatus = 'encerrada' or (not tem_exame_ativo and coalesce(pre_status, '') <> 'agendado'),
           'cancela_ao_apagar', cstatus <> 'encerrada',
           'reservado', proxima is not null and tem_exame_ativo)

         order by (cstatus = 'encerrada'), case when cstatus <> 'encerrada' then proxima end nulls last,
                  case when cstatus = 'encerrada' then encerrada_em else atualizado_em end desc nulls last, criado_em desc), '[]'::jsonb)
    from pronto
   where (jsonb_array_length(exames) > 0
          or (cstatus = 'encerrada' and origem is distinct from 'paciente' and coalesce(motivo, '') not in ('nao_respondido', 'nova_conversa'))
          or (cstatus <> 'encerrada' and primeiro_humano_em is not null))
     and not (cstatus = 'encerrada' and apaga_em < now())
$function$;

CREATE OR REPLACE FUNCTION public.app_pedido_acao(p_token text, p_conversa uuid, p_acao text, p_exame bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  s record; a public.app_paciente%rowtype; c public.conversas; ac public.app_conversa%rowtype; v_tok text; v_tel text; v_email text;
  v_exame record; v_item text; v_texto text; v_assunto text; v_nova jsonb; v_id uuid; v_ntok text; v_passo text; v_antes text; v_i int; v_dir boolean := false;
begin
  if p_acao not in ('conversa', 'ver', 'remarcar', 'cancelar', 'resultado') then return jsonb_build_object('ok', false, 'erro', 'acao', 'mensagem', 'Ação inválida.'); end if;
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into ac from public.app_conversa where paciente_id = s.o_pac and conversa_id = p_conversa;
  if not found then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Não encontrei este pedido neste cadastro.'); end if;
  select * into a from public.app_paciente where id = s.o_pac;
  select * into c from public.conversas where id = p_conversa;
  select token into v_tok from public.conversa_segredo where conversa_id = p_conversa;
  if c.id is null or v_tok is null then return jsonb_build_object('ok', false, 'erro', 'conversa', 'mensagem', 'Esta conversa não está mais disponível.'); end if;

  if p_acao = 'conversa' then
    return jsonb_build_object('ok', true, 'conversa', c.id, 'token', v_tok, 'aberta', c.status <> 'encerrada', 'tipo', coalesce(c.paciente_tipo, 'proprio'), 'paciente_nome', c.paciente_nome,
                              'irmaos', coalesce(c.irmaos, '[]'::jsonb), 'irmaos_modo', c.irmaos_modo);
  end if;

  if p_acao = 'resultado' then
    select e.id, e.procedimento, to_char(e.agendado_para at time zone 'America/Bahia', 'DD/MM/YYYY') as dia into v_exame
      from public.jornada_exame e join public.jornada_card jc on jc.id = e.card_id
     where e.id = p_exame and jc.conversa_id = p_conversa and e.status = 'atendido';
    if not found then return jsonb_build_object('ok', false, 'erro', 'exame', 'mensagem', 'Este exame ainda não aparece como realizado.'); end if;
    v_item := v_exame.procedimento || coalesce(' (feito em ' || v_exame.dia || ')', '');
  else
    v_item := coalesce((select e.procedimento || coalesce(' do dia ' || to_char(e.agendado_para at time zone 'America/Bahia', 'DD/MM/YYYY'), '')
                          from public.jornada_exame e join public.jornada_card jc on jc.id = e.card_id
                         where jc.conversa_id = p_conversa and e.id = p_exame), 'o meu pedido');
  end if;
  v_texto := case p_acao
    when 'resultado' then 'Quero receber o resultado do exame: ' || v_item || '.'
    when 'cancelar' then 'Quero cancelar: ' || v_item || '.'
    when 'remarcar' then 'Quero remarcar: ' || v_item || '.'
    else 'Quero ver as minhas marcações.' end;
  v_assunto := case p_acao when 'resultado' then 'Resultado de exame' when 'cancelar' then 'Cancelar' when 'remarcar' then 'Remarcar' else 'Minhas marcações' end;

  -- conversa ainda aberta: o paciente "escreve" nela; ninguém é encerrado, ninguém perde o atendimento
  if c.status <> 'encerrada' then
    begin perform public.chat_enviar(c.id, v_tok, v_texto);
    exception when others then return jsonb_build_object('ok', false, 'erro', 'enviar', 'mensagem', 'Não foi possível enviar agora. Abra a conversa e escreva por lá.', 'conversa', c.id, 'token', v_tok); end;
    if p_acao = 'resultado' then
      insert into public.app_resultado (paciente_id, conversa_id, exame_id, estado, solicitado_em, conversa_resultado_id)
      values (a.id, c.id, v_exame.id, 'solicitado', now(), c.id)
      on conflict (paciente_id, conversa_id, exame_id) do update set estado = case when public.app_resultado.estado = 'entregue' then 'entregue' else 'solicitado' end,
        solicitado_em = now(), conversa_resultado_id = excluded.conversa_resultado_id;
    end if;
    return jsonb_build_object('ok', true, 'conversa', c.id, 'token', v_tok, 'aberta', true, 'enviada', true, 'tipo', coalesce(c.paciente_tipo, 'proprio'), 'paciente_nome', c.paciente_nome,
                              'irmaos', coalesce(c.irmaos, '[]'::jsonb), 'irmaos_modo', c.irmaos_modo);
  end if;

  -- conversa encerrada: abre uma nova, do mesmo paciente, já no assunto
  select regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), coalesce(c.email_informado, ct.email, a.email) into v_tel, v_email from public.contatos ct where ct.id = c.contato_id;
  v_nova := public.chat_nova_conversa(c.id, v_tok, coalesce(nullif(btrim(c.nome_informado), ''), a.nome), v_tel, v_email, true, true, 'acompanhar', null, null,
                                      coalesce(c.paciente_tipo, 'proprio'), c.paciente_nome, null, null, null, null);
  v_id := (v_nova ->> 'conversa_id')::uuid; v_ntok := v_nova ->> 'token';
  insert into public.app_conversa (paciente_id, conversa_id, pessoa_nome, eu, visto_sig, visto_em) values (a.id, v_id, ac.pessoa_nome, ac.eu, md5(''), now()) on conflict do nothing;

  for v_i in 1..8 loop   -- responde como se o paciente tivesse tocado; para sozinho no primeiro passo que depende dele
    select passo into v_passo from public.conversa_fluxo where conversa_id = v_id;
    exit when v_passo is null or v_passo is not distinct from v_antes;
    v_antes := v_passo;
    begin
      if v_passo in ('cpf_nasc', 'cpf_confirma', 'identidade') then
        exit when coalesce((public.app_chat_dados(p_token, v_id, v_ntok) ->> 'respondeu')::int, 0) = 0;
      elsif v_passo = 'motivo' then perform public.chat_responder(v_id, v_ntok, 'motivo', to_jsonb('assunto'::text), 'Outro assunto', null);
      elsif v_passo = 'assunto' then perform public.chat_responder(v_id, v_ntok, 'assunto', to_jsonb(v_assunto), v_texto, null); v_dir := true;
      elsif v_passo = 'resultado_situacao' and p_acao = 'resultado' then perform public.chat_responder(v_id, v_ntok, 'resultado_situacao', to_jsonb('acesso'::text), 'Receber o link ou a senha do resultado', null);
      elsif v_passo = 'resultado_orientacao' and p_acao = 'resultado' then perform public.chat_responder(v_id, v_ntok, 'resultado_orientacao', to_jsonb('equipe'::text), 'Chamar a equipe agora', null); exit;
      else exit; end if;
    exception when others then exit; end;
  end loop;

  if p_acao = 'resultado' then
    insert into public.app_resultado (paciente_id, conversa_id, exame_id, estado, solicitado_em, conversa_resultado_id)
    values (a.id, p_conversa, v_exame.id, 'solicitado', now(), v_id)
    on conflict (paciente_id, conversa_id, exame_id) do update set estado = case when public.app_resultado.estado = 'entregue' then 'entregue' else 'solicitado' end,
      solicitado_em = now(), conversa_resultado_id = excluded.conversa_resultado_id;
  end if;
  select passo into v_passo from public.conversa_fluxo where conversa_id = v_id;
  return jsonb_build_object('ok', true, 'conversa', v_id, 'token', v_ntok, 'aberta', true, 'nova', true, 'dirigida', v_dir, 'passo', v_passo, 'tipo', coalesce(c.paciente_tipo, 'proprio'),
                            'paciente_nome', c.paciente_nome, 'irmaos', '[]'::jsonb, 'irmaos_modo', null);
end $function$;
