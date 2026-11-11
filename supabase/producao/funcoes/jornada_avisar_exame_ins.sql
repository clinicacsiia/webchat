-- public.jornada_avisar_exame_ins()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_avisar_exame_ins()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce(current_setting('jornada.sem_aviso', true), '') = '1' then return null; end if;
  if not exists (select 1 from n) then return null; end if;   -- "insert ... on conflict" que não criou nada: sem aviso
  begin perform realtime.send(jsonb_build_object('evento', 'jornada_mudou'), 'jornada_mudou', 'fila-chegada', false); exception when others then null; end;
  return null;
end $function$;

