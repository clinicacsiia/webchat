-- public.painel_presenca()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_presenca()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.agentes set visto_em = now() where id = (select auth.uid()) and ativo
$function$;

