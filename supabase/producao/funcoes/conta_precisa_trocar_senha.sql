-- public.conta_precisa_trocar_senha()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_precisa_trocar_senha()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select senha_provisoria from public.contas_paciente where id = (select auth.uid())), false)
$function$;

