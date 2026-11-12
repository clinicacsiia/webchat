-- FLUXOGRAMA: paciente toca em "Voltar e corrigir" -> chat_voltar (confere o token e que o assistente conduz a conversa)
--   -> tenta desfazer, do fim para o começo, a última resposta dada (g_carteira, g_contato, g_ident, mudou, horário, plano, médico, pedido, assunto, motivo)
--   -> cada tentativa é ensaiada e desfeita; vale a primeira que muda a próxima pergunta do roteiro (fluxo_proximo)
--   -> o assistente refaz essa pergunta (fluxo_perguntar). O que o paciente já digitou volta preenchido (dados.digitado).
-- Versão 1.0 — 12/11/2026 / Mudança: Implementação inicial (botão "Voltar e corrigir" no chat)
-- Não mexe em nenhuma função existente. Só cria duas funções novas.
-- Voltar atrás: drop function public.chat_voltar(uuid, text); drop function public.fluxo_voltar_passo(uuid, int);

create or replace function public.fluxo_voltar_passo(p_conversa uuid, p_op int)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare d jsonb; v_motivo text;
begin
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb); v_motivo := d ->> 'motivo';
  case p_op
  when 1 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "g_carteira": false}');
  when 2 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "g_contato": false, "g_endereco": false}');
  when 3 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "g_ident": false}');
  when 4 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "mudou": null}');
  when 5 then
    update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null where conversa_id = p_conversa and status = 'rascunho';
    perform public.fluxo_set(p_conversa, '{"confirmado": false, "sem_horario": false}');
  when 6 then
    perform public.fluxo_set(p_conversa, jsonb_build_object('confirmado', false, 'plano_anterior', null, 'plano_trocado_de', null));
    update public.pre_agendamentos set plano = null where conversa_id = p_conversa and status = 'rascunho';
  when 7 then
    perform public.fluxo_set(p_conversa, '{"confirmado": false, "medico_feito": false}');
    update public.conversas set medico_preferido = null where id = p_conversa;
  when 8 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "refazer": "pedido"}');
  when 9 then
    if v_motivo = 'assunto' then perform public.fluxo_set(p_conversa, '{"assunto": null}'); end if;
  when 10 then
    perform public.fluxo_set(p_conversa, '{"confirmado": false, "motivo": null, "refazer": null, "medico_feito": false, "assunto": null}');
    update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;
    update public.conversas set unidade_inicial = null, medico_preferido = null where id = p_conversa;
  else null;
  end case;
end $function$;

create or replace function public.chat_voltar(p_conversa uuid, p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare c public.conversas; v_passo text; v_p text; v_novo text; i int; v_antes bigint;
begin
  perform public.chat_valida(p_conversa, p_token);
  select * into c from public.conversas where id = p_conversa for update;
  select passo into v_passo from public.conversa_fluxo where conversa_id = p_conversa;
  if c.motor <> 'fluxo' or not (c.ia_ativa and c.status = 'aguardando') or v_passo is null then
    raise exception 'Não dá para voltar agora. Veja a última mensagem.' using errcode = '22023';
  end if;
  if v_passo in ('identidade', 'atalho', 'motivo', 'pronto', 'humano', 'assunto_fim') then
    raise exception 'Esta é a primeira pergunta: não há o que corrigir antes dela.' using errcode = '22023';
  end if;
  select coalesce(max(id), 0) into v_antes from public.mensagens where conversa_id = p_conversa;
  -- cada tentativa é ensaiada e desfeita (o erro de propósito desfaz só o que foi mexido no bloco); a primeira que muda a pergunta vale
  for i in 1..10 loop
    begin
      perform public.fluxo_voltar_passo(p_conversa, i);
      v_p := public.fluxo_proximo(p_conversa);
      raise exception 'ensaio' using errcode = 'P0001';
    exception when sqlstate 'P0001' then null;
    end;
    if v_p is distinct from v_passo and v_p is not null then
      perform public.fluxo_voltar_passo(p_conversa, i);
      v_novo := public.fluxo_proximo(p_conversa);
      exit;
    end if;
  end loop;
  if v_novo is null or v_novo in ('pronto', v_passo) then
    raise exception 'Não dá para voltar agora. Veja a última mensagem.' using errcode = '22023';
  end if;
  insert into public.fluxo_evento (conversa_id, passo, entrada, entendido) values (p_conversa, v_passo, 'voltar', true);
  perform public.fluxo_perguntar(p_conversa, v_novo, 'Tudo bem, vamos corrigir.');
  return jsonb_build_object('passo', v_novo, 'respostas', public.chat_respostas(p_conversa, v_antes));
end $function$;

revoke all on function public.fluxo_voltar_passo(uuid, int) from public, anon, authenticated;
grant execute on function public.fluxo_voltar_passo(uuid, int) to service_role;
revoke all on function public.chat_voltar(uuid, text) from public;
grant execute on function public.chat_voltar(uuid, text) to anon, authenticated, service_role;
