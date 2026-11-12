-- public.klingo_cfg(p_chave text, p_padrao text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_cfg(p_chave text, p_padrao text DEFAULT ''::text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select valor from public.config where chave = p_chave), p_padrao)
$function$;

