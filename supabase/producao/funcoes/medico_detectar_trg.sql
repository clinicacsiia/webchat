-- public.medico_detectar_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.medico_detectar_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.tipo = 'agenda' then perform public.medico_detectar(); end if;
  return null;
end $function$;

