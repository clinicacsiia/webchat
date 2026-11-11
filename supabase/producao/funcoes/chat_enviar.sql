-- public.chat_enviar(p_conversa uuid, p_token text, p_texto text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_enviar(p_conversa uuid, p_token text, p_texto text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_txt text; v_id bigint; c public.conversas; v_dias integer;
begin
  v_txt := btrim(coalesce(p_texto, ''));
  if v_txt = '' or char_length(v_txt) > 4000 then raise exception 'Mensagem inválida.' using errcode = '22023'; end if;
  perform 1 from public.conversa_segredo where conversa_id = p_conversa and token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  select * into c from public.conversas where id = p_conversa;
  if c.status = 'encerrada' then
    v_dias := coalesce((select case when valor ~ '^[0-9]+$' then valor::int end from public.config where chave = 'reabrir_dias'), 2);
    if c.encerramento_origem = 'paciente' then
      raise exception 'Esta conversa foi encerrada porque você abriu uma nova. Continue pela conversa nova.' using errcode = '22023';
    end if;
    if c.encerrada_em is not null and c.encerrada_em < now() - make_interval(days => v_dias) then
      raise exception 'Esta conversa foi encerrada há mais de % dias. Abra uma nova conversa (o histórico fica salvo).', v_dias using errcode = '22023';
    end if;
  end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  update public.conversas set
    status = case when status = 'encerrada' then 'aguardando' else status end,
    agente_id = case when status = 'encerrada' then null else agente_id end
  where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_id;
  return jsonb_build_object('id', v_id, 'respostas', public.chat_respostas(p_conversa, v_id - 1));
end $function$;

