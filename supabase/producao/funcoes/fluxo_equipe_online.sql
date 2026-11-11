-- public.fluxo_equipe_online()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_equipe_online()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.agentes where ativo and papel in ('admin', 'atendente') and visto_em > now() - interval '3 minutes')
$function$;

