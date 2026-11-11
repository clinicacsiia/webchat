-- public.fluxo_medicos(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_medicos(p_conversa uuid)
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select x.medicos from public.conversas c
  left join public.unidade_config u on u.chave = c.unidade_inicial
  join public.pre_agendamento_itens i on i.conversa_id = c.id and i.ativo and i.modalidade = 'CONSULTA'
  cross join lateral public.consultas_da_unidade(u.catalogo) x
  where c.id = p_conversa and x.id = i.procedimento_id
  limit 1
$function$;

