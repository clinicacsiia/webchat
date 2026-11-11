-- public.fluxo_set(p_conversa uuid, p_dados jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_set(p_conversa uuid, p_dados jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.conversa_fluxo set dados = dados || p_dados, atualizado_em = now() where conversa_id = p_conversa
$function$;

