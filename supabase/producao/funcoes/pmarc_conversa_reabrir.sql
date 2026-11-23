-- public.pmarc_conversa_reabrir(p_pessoa uuid, p_conv uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_conversa_reabrir(p_pessoa uuid, p_conv uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c public.conversas;
begin
  select * into c from public.conversas where id = p_conv for update;
  if not found or c.status <> 'encerrada' then return false; end if;
  update public.conversas set status = 'aguardando', agente_id = null where id = p_conv;
  -- reabrir religa o robô e apaga o resumo: na Previsão o robô continua desligado e o resumo volta
  update public.conversas set ia_ativa = false, triagem_resumo = c.triagem_resumo, triagem_urgencia = c.triagem_urgencia where id = p_conv;
  -- a conversa nova começa na próxima mensagem (o paciente não vê a anterior) e o aviso final é dito de novo
  update public.pmarc_pessoa set atualizado_em = now(),
    informado = (informado - 'final_em') || jsonb_build_object('msg_desde', coalesce((select max(id) from public.mensagens where conversa_id = p_conv), 0) + 1)
  where id = p_pessoa;
  return true;
end $function$;

