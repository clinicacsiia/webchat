-- public.conta_precisa_trocar_senha()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_precisa_trocar_senha()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  return (select coalesce((select senha_provisoria from public.contas_paciente where id = (select auth.uid())), false));
end $function$;

