-- public.conversa_limpa_aguarda_paciente_trg()
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.conversa_limpa_aguarda_paciente_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.status is distinct from old.status then new.aguarda_paciente_desde := null; end if;
  return new;
end $function$;

