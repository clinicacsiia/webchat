-- public.chat_avaliacao_estado(p_conversa uuid, p_token text, p_encerrada_em text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_avaliacao_estado(p_conversa uuid, p_token text, p_encerrada_em text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c record; v_ativa boolean; v_inst timestamptz;
begin
  perform public.chat_valida(p_conversa, p_token);
  v_ativa := coalesce((select valor from public.config where chave = 'avaliacao_ativa'), 'nao') = 'sim';
  begin v_inst := p_encerrada_em::timestamptz; exception when others then v_inst := null; end;
  select status, encerrada_em, motivo_encerramento into c from public.conversas where id = p_conversa;
  if not v_ativa or v_inst is null or c.status is distinct from 'encerrada' or c.encerrada_em is distinct from v_inst
     or c.motivo_encerramento = 'nao_respondido' then
    return jsonb_build_object('mostrar', false);
  end if;
  return jsonb_build_object('mostrar', not exists (select 1 from public.avaliacao_atendimento a where a.conversa_id = p_conversa and a.encerrada_em = c.encerrada_em),
                            'avaliou', exists (select 1 from public.avaliacao_atendimento a where a.conversa_id = p_conversa and a.encerrada_em = c.encerrada_em));
end $function$;

