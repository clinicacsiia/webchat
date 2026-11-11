-- public.conversa_exame_aberto_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversa_exame_aberto_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- Decisão do dono (09/11/2026): a escolha da atendente é prioridade. Exame marcado, em aberto ou já passado NUNCA barra o encerramento.
  -- O exame continua na Jornada e o Klingo fecha o desfecho; o motivo Agendado ainda gera a conferência em segundo plano (com aviso).
  return new;
end $function$;

