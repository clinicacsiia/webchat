-- public.klingo_aceita_sombra(p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_aceita_sombra(p_chave text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$ select p_chave in ('klingo_api_horarios', 'previsao_monitor_modo', 'klingo_api_resultado') $function$;

