-- public.conversas_conta_trg()
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.conversas_conta_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  new.conta_id := (select cp.id from public.contas_paciente cp where cp.id = (select auth.uid()));
  return new;
end $function$;

