-- public.chat_voltar(p_conversa uuid, p_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_voltar(p_conversa uuid, p_token text)
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
