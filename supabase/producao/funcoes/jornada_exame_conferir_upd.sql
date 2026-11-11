-- public.jornada_exame_conferir_upd()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_exame_conferir_upd()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if exists (select 1 from n join o on o.id = n.id where n.status is distinct from o.status and n.status in ('atendido', 'faltou', 'cancelado', 'remarcado')) then
    begin perform public.agendamento_conferir_klingo(); exception when others then null; end;
  end if;
  return null;
end $function$;

