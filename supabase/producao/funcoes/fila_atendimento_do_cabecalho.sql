-- public.fila_atendimento_do_cabecalho()
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_atendimento_do_cabecalho()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return public.fila_atendimento_de(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-fila-token');
exception when others then
  return null;
end $function$;

