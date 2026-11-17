-- public.pmarc_tipo_proc(p_modalidade text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_tipo_proc(p_modalidade text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  select case when p_modalidade = 'CONSULTA' then 'consulta'
              when p_modalidade in ('RM', 'TC', 'US', 'RX', 'MAMO', 'DENSITO') then 'exame'
              else 'outro' end
$function$;

