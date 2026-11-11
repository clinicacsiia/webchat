-- Definição que estava na PRODUÇÃO até 11/11/2026 10:23 UTC, ANTES da correção da auditoria.
-- Guardada só para o teste (testes/sql-producao.test.mjs) reproduzir o defeito antes de aplicar a correção. NÃO aplicar no banco.
CREATE OR REPLACE FUNCTION public.jornada_avisar_exame_ins()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce(current_setting('jornada.sem_aviso', true), '') = '1' then return null; end if;
  begin perform realtime.send(jsonb_build_object('evento', 'jornada_mudou'), 'jornada_mudou', 'fila-chegada', false); exception when others then null; end;
  return null;
end $function$;
