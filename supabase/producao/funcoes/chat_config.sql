-- public.chat_config()
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_config()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_object_agg(chave, valor), '{}'::jsonb)
  from public.config where chave in ('nome_empresa', 'boas_vindas')
$function$;

