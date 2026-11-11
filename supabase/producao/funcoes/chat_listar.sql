-- public.chat_listar(p_conversa uuid, p_token text, p_apos bigint)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_listar(p_conversa uuid, p_token text, p_apos bigint DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_status text; v_agente text; v_motor boolean; v_passo text;
begin
  select c.status, a.nome, (c.motor = 'fluxo' and c.ia_ativa and c.status = 'aguardando'), f.passo into v_status, v_agente, v_motor, v_passo
  from public.conversas c
  join public.conversa_segredo s on s.conversa_id = c.id
  left join public.agentes a on a.id = c.agente_id
  left join public.conversa_fluxo f on f.conversa_id = c.id
  where c.id = p_conversa and s.token = p_token;
  if not found then raise exception 'Conversa não encontrada.' using errcode = '28000'; end if;
  return jsonb_build_object('status', v_status, 'agente', v_agente, 'motor_ativo', coalesce(v_motor, false), 'passo', v_passo,
    'mensagens', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'autor', m.autor, 'texto', m.texto, 'opcoes', m.opcoes, 'criado_em', m.criado_em,
                                          'editada_em', m.editada_em, 'excluida_em', m.excluida_em,
                                          'agente', coalesce(ag.nome, case when m.autor = 'agente' then 'Assistente virtual' end)) order by m.id)
      from (select * from public.mensagens where conversa_id = p_conversa and id > coalesce(p_apos, 0) order by id limit 200) m
      left join public.agentes ag on ag.id = m.agente_id), '[]'::jsonb),
    'alteradas', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'texto', x.texto, 'editada_em', x.editada_em, 'excluida_em', x.excluida_em) order by x.id)
      from (select id, texto, editada_em, excluida_em from public.mensagens
             where conversa_id = p_conversa and id <= coalesce(p_apos, 0)
               and greatest(editada_em, excluida_em) > now() - interval '24 hours' order by id desc limit 50) x), '[]'::jsonb));
end $function$;

