-- public.modalidade_de(p_classe text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.modalidade_de(p_classe text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case
    when p_classe ilike 'RESSONANCIA%' then 'RM'
    when p_classe ilike 'TOMOGRAFIA%' then 'TC'
    when p_classe ilike 'ULTRASS%' or p_classe ilike 'ULTRASON%' or p_classe ilike 'PROCEDIMENTOS GUIADOS POR USG%' then 'US'
    when p_classe = 'RADIOLOGIA' then 'RX'
    when p_classe = 'MAMOGRAFIA' then 'MAMO'
    when p_classe = 'DENSITOMETRIA' then 'DENSITO'
    when p_classe = 'CONSULTAS' then 'CONSULTA'
    else 'OUTRO' end
$function$;

