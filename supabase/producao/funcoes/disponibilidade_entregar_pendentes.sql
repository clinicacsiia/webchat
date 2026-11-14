-- public.disponibilidade_entregar_pendentes()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_entregar_pendentes()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare n record; v_ent integer := 0; v_msg bigint;
begin
  for n in select nt.id, nt.pedido_id, nt.oportunidade_id, p.conversa_id, p.procedimento_nome, o.valida_ate, o.estado as ostado from public.disponibilidade_notificacao nt
             join public.disponibilidade_pedido p on p.id = nt.pedido_id join public.disponibilidade_oportunidade o on o.id = nt.oportunidade_id
            where nt.estado = 'pendente' and p.estado = 'oportunidade_identificada' order by nt.criado_em limit 50 loop
    continue when not public.klingo_ativo(n.conversa_id, 'notificacao_modo');
    if n.valida_ate <= now() or n.ostado <> 'nova' then update public.disponibilidade_notificacao set estado = 'falhou', detalhe = 'oportunidade_expirada' where id = n.id; continue; end if;
    begin
      v_msg := public.fluxo_dizer(n.conversa_id, 'Encontramos uma possibilidade de horário compatível com a sua solicitação (' || coalesce(n.procedimento_nome, 'atendimento') || '). Consulte a disponibilidade atual para tentar realizar o agendamento: o horário ainda NÃO está reservado para você.',
        jsonb_build_object('tipo', 'disponibilidade_oportunidade', 'solicitacao', n.pedido_id, 'oportunidade', n.oportunidade_id));
      update public.disponibilidade_notificacao set estado = 'entregue_ao_chat', entregue_em = now(), detalhe = 'mensagem ' || v_msg where id = n.id;
      update public.disponibilidade_oportunidade set estado = 'notificada' where id = n.oportunidade_id;
      perform public.disponibilidade_mudar_estado(n.pedido_id, 'notificada', 'sistema', jsonb_build_object('canal', 'chat'));
      v_ent := v_ent + 1;
    exception when others then
      update public.disponibilidade_notificacao set estado = 'falhou', detalhe = left(sqlerrm, 120) where id = n.id;
    end;
  end loop;
  return v_ent;
end $function$;

