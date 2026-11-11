-- public.jornada_exame_conferir_ins()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_exame_conferir_ins()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if exists (select 1 from n where n.status in ('atendido', 'faltou', 'cancelado', 'remarcado')) then
    begin perform public.agendamento_conferir_klingo(); exception when others then null; end;
  end if;
  return null;
end $function$;

