-- public.fluxo_procs(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_procs(p_conversa uuid)
 RETURNS integer[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select array_agg(i.procedimento_id order by i.id) from public.pre_agendamento_itens i, lateral generate_series(1, i.quantidade) g
  where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null
$function$;

