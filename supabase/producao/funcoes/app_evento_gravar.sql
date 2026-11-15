-- public.app_evento_gravar(p_pac uuid, p_tipo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_evento_gravar(p_pac uuid, p_tipo text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.app_evento (paciente_id, tipo) values (p_pac, p_tipo) $function$;

