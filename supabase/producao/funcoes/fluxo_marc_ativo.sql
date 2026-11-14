-- public.fluxo_marc_ativo(p_conversa uuid, d jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_marc_ativo(p_conversa uuid, d jsonb)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select d ->> 'assunto' in ('Remarcar', 'Cancelar', 'Minhas marcações') and coalesce(d ->> 'marc_estado', '') not in ('', 'local') and public.klingo_ativo(p_conversa, 'klingo_api_consultar')
$function$;

