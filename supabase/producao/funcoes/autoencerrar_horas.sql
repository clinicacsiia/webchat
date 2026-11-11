-- public.autoencerrar_horas()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.autoencerrar_horas()
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select case when valor ~ '^[0-9]+$' and valor::int between 1 and 720 then valor::int end from public.config where chave = 'autoencerrar_horas'), 24)
$function$;

