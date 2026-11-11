-- public.chat_push_config()
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_push_config()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('vapid', coalesce((select valor from public.config where chave = 'fila_vapid_publica'), ''))
$function$;

