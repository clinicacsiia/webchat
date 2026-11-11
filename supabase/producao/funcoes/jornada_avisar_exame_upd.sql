-- public.jornada_avisar_exame_upd()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_avisar_exame_upd()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce(current_setting('jornada.sem_aviso', true), '') = '1' then return null; end if;
  if exists (select 1 from n join o on o.id = n.id where n.status is distinct from o.status or n.confirm_status is distinct from o.confirm_status) then
    begin perform realtime.send(jsonb_build_object('evento', 'jornada_mudou'), 'jornada_mudou', 'fila-chegada', false); exception when others then null; end;
  end if;
  return null;
end $function$;

