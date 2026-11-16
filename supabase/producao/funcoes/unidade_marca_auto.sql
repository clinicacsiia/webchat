-- public.unidade_marca_auto(p_unidade text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.unidade_marca_auto(p_unidade text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select c.valor <> 'nao' from public.config c where c.chave = 'marcacao_auto_' || public.unidade_chave(p_unidade)), true)
$function$;

