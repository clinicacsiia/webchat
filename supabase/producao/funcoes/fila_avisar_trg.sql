-- public.fila_avisar_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_avisar_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform realtime.send(jsonb_build_object('evento', 'fila_mudou'), 'fila_mudou', 'fila:global', true);
  if tg_op = 'UPDATE' then
    perform realtime.send(jsonb_build_object('status', new.status, 'bloqueado', new.bloqueado_em is not null),
                          'status', 'atendimento:' || new.id::text, true);
  end if;
  return null;
exception when others then
  raise warning 'fila_avisar_trg: %', sqlerrm;
  return null;
end $function$;

