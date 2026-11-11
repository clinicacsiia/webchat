-- public.fila_config_publica()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_config_publica()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('vapid', coalesce((select valor from public.config where chave = 'fila_vapid_publica'), ''))
$function$;

