-- public.conversas_motor_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversas_motor_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  new.motor := 'fluxo';
  return new;
end $function$;

