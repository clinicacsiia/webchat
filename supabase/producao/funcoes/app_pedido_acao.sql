-- public.app_pedido_acao(p_token text, p_conversa uuid, p_acao text, p_exame bigint)
-- Pode executar: anon, authenticated
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

