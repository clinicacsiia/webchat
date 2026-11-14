-- public.painel_disponibilidade_lista(p_estado text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_disponibilidade_lista(p_estado text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'contagem', coalesce((select jsonb_object_agg(estado, n) from (select estado, count(*) n from public.disponibilidade_pedido group by estado) x), '{}'::jsonb),
    'itens', coalesce((select jsonb_agg(q.i order by q.prioridade, q.criado_em desc) from (
      select jsonb_build_object('id', p.id, 'conversa_id', p.conversa_id, 'paciente', coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), nullif(btrim(c.paciente_nome), ''), nullif(btrim(c.nome_informado), ''), ct.nome),
               'paciente_tipo', p.paciente_tipo, 'tipo', p.tipo, 'procedimento', p.procedimento_nome, 'plano', p.plano, 'unidade', p.unidade, 'data_ini', p.data_ini, 'data_fim', p.data_fim, 'dias_semana', to_jsonb(p.dias_semana),
               'turno', p.turno, 'estado', p.estado, 'criado_em', p.criado_em, 'expira_em', p.expira_em, 'ultima_verificacao_em', p.ultima_verificacao_em, 'ultima_verificacao_resultado', p.ultima_verificacao_resultado,
               'ultima_oportunidade', p.ultima_oportunidade, 'ultima_oportunidade_em', p.ultima_oportunidade_em, 'aceita_notificacao', p.aceita_notificacao, 'canais', to_jsonb(p.canais), 'conversa_status', c.status,
               'notificacao', (select n.estado from public.disponibilidade_notificacao n where n.pedido_id = p.id order by n.criado_em desc limit 1),
               'precisa_humano', exists (select 1 from public.disponibilidade_notificacao n where n.pedido_id = p.id and n.estado in ('bloqueada_sem_autorizacao', 'falhou') and n.criado_em > now() - interval '7 days') and p.estado in ('ativa', 'oportunidade_identificada'),
               'historico', coalesce((select jsonb_agg(jsonb_build_object('em', e.em, 'tipo', e.tipo, 'origem', e.origem) order by e.em desc) from (select * from public.disponibilidade_evento ev where ev.pedido_id = p.id order by ev.em desc limit 8) e), '[]'::jsonb)) as i,
             case p.estado when 'oportunidade_identificada' then 0 when 'notificada' then 1 when 'aguardando_resposta' then 2 when 'ativa' then 3 else 4 end as prioridade, p.criado_em
        from public.disponibilidade_pedido p join public.conversas c on c.id = p.conversa_id join public.contatos ct on ct.id = c.contato_id left join public.pre_agendamentos pa on pa.conversa_id = p.conversa_id
       where p_estado is null or p_estado = '' or p.estado = p_estado limit 500) q), '[]'::jsonb));
end $function$;

