-- public.convenio_ativo(p_operadora text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.convenio_ativo(p_operadora text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case when public.convenio_chave(p_operadora) ~ '^(|PARTICULAR.*)$' then true
    else coalesce((select c.ativo and c.suspenso_em is null from public.convenio_config c where c.operadora = public.convenio_chave(p_operadora)), true) end
$function$;

