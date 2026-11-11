-- public.agendamento_remarcacao_feita_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agendamento_remarcacao_feita_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.status = 'agendado' and old.status is distinct from 'agendado' then
    update public.agendamento_fechamento set remarcacao = 'feita', atualizado_em = now()
     where remarcacao = 'aceita' and remarcacao_conversa = new.conversa_id;
  end if;
  return new;
end $function$;

