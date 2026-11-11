-- public.jornada_regra_ativa(p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.jornada_regra_ativa(p_chave text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce((select ativa from public.jornada_regra where chave = p_chave), false);
$function$;

