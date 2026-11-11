-- public.jornada_avisar_card_upd()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_avisar_card_upd()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce(current_setting('jornada.sem_aviso', true), '') = '1' then return null; end if;
  if exists (select 1 from n join o on o.id = n.id where n.coluna is distinct from o.coluna or n.arquivado_em is distinct from o.arquivado_em) then
    begin perform realtime.send(jsonb_build_object('evento', 'jornada_mudou'), 'jornada_mudou', 'fila-chegada', false); exception when others then null; end;
  end if;
  return null;
end $function$;

