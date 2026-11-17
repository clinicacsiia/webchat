-- public.pmarc_tipo(p_procedimento text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_tipo(p_procedimento text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case when lower(coalesce(p_procedimento, '')) ~ '^\s*(consulta|retorno|teleconsulta)' then 'consulta' else 'exame' end
$function$;

