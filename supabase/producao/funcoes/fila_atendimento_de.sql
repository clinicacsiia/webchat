-- public.fila_atendimento_de(p_token text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_atendimento_de(p_token text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select nullif(public.fila_jwt_validar(p_token) ->> 'atendimento_id', '')::uuid
$function$;

