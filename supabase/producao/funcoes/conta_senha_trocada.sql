-- public.conta_senha_trocada()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_senha_trocada()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.contas_paciente set senha_provisoria = false where id = (select auth.uid())
$function$;

