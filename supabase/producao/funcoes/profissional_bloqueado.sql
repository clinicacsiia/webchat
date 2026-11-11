-- public.profissional_bloqueado(p_nome text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.profissional_bloqueado(p_nome text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from public.profissional_bloqueio b where b.profissional = public.norm_nome(p_nome))
$function$;

