-- public.klingo_marc_quando(p_data date, p_hora text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_marc_quando(p_data date, p_hora text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$ select (array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'])[extract(dow from p_data)::int + 1] || ', ' || to_char(p_data, 'DD/MM') || coalesce(' às ' || nullif(p_hora, ''), '') $function$;

