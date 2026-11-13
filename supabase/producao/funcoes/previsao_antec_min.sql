-- public.previsao_antec_min(p_antecedencia text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.previsao_antec_min(p_antecedencia text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case p_antecedencia when '1_dia' then 1440 when '1_semana' then 10080 when '1_mes' then 43200 else 120 end
$function$
;
