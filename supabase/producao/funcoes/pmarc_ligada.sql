-- public.pmarc_ligada()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_ligada()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select valor from public.config where chave = 'previsao_marcacao_modo'), 'nao') = 'sim'
$function$;

