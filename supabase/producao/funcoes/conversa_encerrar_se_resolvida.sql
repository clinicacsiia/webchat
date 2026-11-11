-- public.conversa_encerrar_se_resolvida(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversa_encerrar_se_resolvida(p_conversa uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_mem uuid[] := public.pessoa_membros(p_conversa); v_n integer := 0; c record;
begin
  if exists (select 1 from public.v_agendamento_aberto v where v.conversa_id = any (v_mem)) then return 0; end if;
  if exists (select 1 from public.v_remarcacao_pendente r where r.conversa_id = any (v_mem)) then return 0; end if;
  for c in select id, status from public.conversas where id = any (v_mem) and status <> 'encerrada' loop
    if c.status = 'em_atendimento' then
      update public.conversas set alerta_agenda = 'Exame concluído e conferido no Klingo. Pode encerrar a conversa.' where id = c.id;
    else
      update public.conversas set status = 'encerrada', encerrada_em = now(), ia_ativa = false, alerta_agenda = null, atualizado_em = now(),
        motivo_encerramento = 'agendado', encerramento_origem = 'sistema' where id = c.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $function$;

