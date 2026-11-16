-- public.particular_valor_assinatura(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.particular_valor_assinatura(p_conversa uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select md5(coalesce((select public.norm_chave(pa.plano) from public.pre_agendamentos pa where pa.conversa_id = p_conversa), '') || '|' ||
    coalesce((select string_agg(coalesce(i.procedimento_id::text, 'x') || ':' || coalesce(i.quantidade, 1)::text || ':' || coalesce(i.lado, ''), ',' order by i.procedimento_id nulls last, i.lado nulls first, i.id)
                from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo), ''))
$function$;

