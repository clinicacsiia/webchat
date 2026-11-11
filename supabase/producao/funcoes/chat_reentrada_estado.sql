-- public.chat_reentrada_estado(p_conversa uuid, p_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_reentrada_estado(p_conversa uuid, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c public.conversas; v_dias integer; v_ult timestamptz; v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
begin
  select c2.* into c from public.conversas c2 join public.conversa_segredo s on s.conversa_id = c2.id where c2.id = p_conversa and s.token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  v_dias := coalesce((select case when valor ~ '^[0-9]+$' then valor::int end from public.config where chave = 'reabrir_dias'), 2);
  select greatest(c.criado_em, coalesce(max(m.criado_em), c.criado_em)) into v_ult from public.mensagens m where m.conversa_id = c.id;
  return jsonb_build_object(
    'status', c.status, 'aberta', c.status <> 'encerrada', 'encerrada_em', c.encerrada_em, 'janela_dias', v_dias,
    'pode_voltar', c.status <> 'encerrada' or (c.encerrada_em > now() - make_interval(days => v_dias) and coalesce(c.encerramento_origem, '') <> 'paciente'),
    'mesmo_dia', (v_ult at time zone 'America/Sao_Paulo')::date = v_hoje,
    'teve_resposta_humana', c.primeiro_humano_em is not null,
    'em_atendimento', c.status = 'em_atendimento');
end $function$;

