-- public.disponibilidade_json(p disponibilidade_pedido)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_json(p public.disponibilidade_pedido)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object('id', p.id, 'estado', p.estado, 'tipo', p.tipo, 'procedimento', p.procedimento_nome, 'plano', p.plano, 'unidade', p.unidade,
    'aceita_outras_unidades', p.aceita_outras_unidades, 'profissional', p.profissional_preferido, 'aceita_outros_profissionais', p.aceita_outros_profissionais,
    'data_ini', p.data_ini, 'data_fim', p.data_fim, 'datas_alternativas', p.datas_alternativas, 'dias_semana', to_jsonb(p.dias_semana), 'turno', p.turno, 'hora_ini', p.hora_ini, 'hora_fim', p.hora_fim,
    'aceita_notificacao', p.aceita_notificacao, 'canais', to_jsonb(p.canais), 'criado_em', p.criado_em, 'expira_em', p.expira_em,
    'oportunidade', (select jsonb_build_object('id', o.id, 'data', o.data, 'hora', o.hora, 'unidade', o.unidade, 'profissional', o.profissional, 'valida_ate', o.valida_ate)
                       from public.disponibilidade_oportunidade o where o.pedido_id = p.id and o.estado = 'notificada' and o.valida_ate > now() order by o.encontrada_em desc limit 1))
$function$;

