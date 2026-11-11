-- public.conversa_transferida_reinicia_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversa_transferida_reinicia_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if old.agente_id is not null and new.agente_id is not null and new.agente_id is distinct from old.agente_id
     and new.status = 'em_atendimento' and new.aguarda_paciente_desde is not null then
    new.aguarda_paciente_desde := now();
  end if;
  return new;
end $function$;

