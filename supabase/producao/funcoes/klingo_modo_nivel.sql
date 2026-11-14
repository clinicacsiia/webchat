-- public.klingo_modo_nivel(p_valor text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_modo_nivel(p_valor text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$ select case lower(coalesce(p_valor, '')) when 'sombra' then 1 when 'teste' then 2 when 'ligado' then 3 when 'sim' then 3 when 'legado' then 3 else 0 end $function$;

