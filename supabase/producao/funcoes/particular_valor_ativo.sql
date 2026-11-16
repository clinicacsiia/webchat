-- public.particular_valor_ativo(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.particular_valor_ativo(p_conversa uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select public.klingo_cfg('particular_valor_modo', 'nao') = 'sim'
     and coalesce((select public.norm_chave(pa.plano) like 'PARTICULAR%' from public.pre_agendamentos pa where pa.conversa_id = p_conversa), false)
     and not coalesce((select jsonb_typeof(f.dados -> 'remarcando') = 'object' from public.conversa_fluxo f where f.conversa_id = p_conversa), false)
$function$;

