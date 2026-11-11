-- public.fila_push_remover(p_endpoint text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_push_remover(p_endpoint text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  delete from public.push_inscricao where endpoint = p_endpoint and conta_id = (select auth.uid())
$function$;

