-- public.conversa_limpa_aguarda_paciente_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversa_limpa_aguarda_paciente_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.status is distinct from old.status then new.aguarda_paciente_desde := null; new.chamar_zap_em := null; end if;
  return new;
end $function$;

