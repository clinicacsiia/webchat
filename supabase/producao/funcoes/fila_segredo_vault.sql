-- public.fila_segredo_vault(p_nome text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_segredo_vault(p_nome text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select decrypted_secret from vault.decrypted_secrets where name = p_nome limit 1
$function$;

