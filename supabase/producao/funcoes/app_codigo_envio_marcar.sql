-- public.app_codigo_envio_marcar(p_id uuid, p_ok boolean, p_erro text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_codigo_envio_marcar(p_id uuid, p_ok boolean, p_erro text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.app_codigo_email set envio = case when p_ok then 'enviado' else 'erro' end, envio_erro = case when p_ok then null else left(coalesce(p_erro, 'falha'), 120) end where id = p_id $function$;

