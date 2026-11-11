-- public.fila_chegada_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_chegada_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.fila_recalcular();
  return null;
end $function$;

