-- public.chat_respostas(p_conversa uuid, p_apos bigint)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.chat_respostas(p_conversa uuid, p_apos bigint)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'autor', m.autor, 'texto', m.texto, 'opcoes', m.opcoes, 'criado_em', m.criado_em,
                                               'agente', coalesce(ag.nome, case when m.autor = 'agente' then 'Assistente virtual' end)) order by m.id), '[]'::jsonb)
  from public.mensagens m left join public.agentes ag on ag.id = m.agente_id
  where m.conversa_id = p_conversa and m.id > p_apos
$function$;

