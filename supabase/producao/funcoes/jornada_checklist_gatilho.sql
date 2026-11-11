-- public.jornada_checklist_gatilho()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_checklist_gatilho()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.jornada_checklist_do_card(new.id);
  return null;
exception when others then
  raise warning 'jornada_checklist_gatilho: %', sqlerrm;
  return null;
end;
$function$;

