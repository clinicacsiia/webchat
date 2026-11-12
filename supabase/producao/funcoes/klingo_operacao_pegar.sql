-- public.klingo_operacao_pegar(p_op uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_operacao_pegar(p_op uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare op public.klingo_operacao; d jsonb; o public.klingo_oferta;
begin
  update public.klingo_operacao set estado = 'executando', iniciado_em = now(), tentativas = tentativas + 1 where id = p_op and estado = 'pendente' returning * into op;
  if op.id is null then return jsonb_build_object('ok', false, 'motivo', 'nao_pendente'); end if;
  d := public.klingo_dados_conversa(op.conversa_id);
  select * into o from public.klingo_oferta where conversa_id = op.conversa_id and chave = op.detalhe ->> 'chave';
  return jsonb_build_object('ok', true, 'operacao', jsonb_build_object('id', op.id, 'tipo', op.tipo, 'conversa_id', op.conversa_id, 'pre_agendamento_id', op.pre_agendamento_id, 'detalhe', op.detalhe, 'tentativas', op.tentativas),
    'dados', d, 'oferta', case when o.id is null then null else jsonb_build_object('chave', o.chave, 'procedimento', o.procedimento, 'plano', o.plano, 'data', o.data, 'hora', o.hora, 'profissional', o.profissional, 'unidade', o.unidade, 'unidade_id', o.unidade_id) end);
end $function$;

