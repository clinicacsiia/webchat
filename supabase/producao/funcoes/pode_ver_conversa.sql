-- public.pode_ver_conversa(p_conversa uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.pode_ver_conversa(p_conversa uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.org_pode_ver((select auth.uid()), (select public.papel_atual()), c.agente_id, coalesce(c.unidade_responsavel, c.unidade_inicial))
    from public.conversas c where c.id = p_conversa
$function$;

