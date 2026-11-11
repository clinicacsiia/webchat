-- public.chat_irmao_iniciar(p_origem uuid, p_token text)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_irmao_iniciar(p_origem uuid, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  o public.conversas; src public.pre_agendamentos; v_prox text; v_resto jsonb; v_recentes int; v_conv uuid; v_token text;
  v_copia boolean := false; v_msg text;
begin
  perform public.chat_valida(p_origem, p_token);
  select * into o from public.conversas where id = p_origem;
  if o.paciente_tipo <> 'filho' or jsonb_array_length(o.irmaos) = 0 then
    raise exception 'Não há outro filho(a) para agendar.' using errcode = '22023';
  end if;
  v_prox := o.irmaos ->> 0;
  v_resto := o.irmaos - 0;
  select c.id, s.token into v_conv, v_token from public.conversas c join public.conversa_segredo s on s.conversa_id = c.id
  where c.irmao_de = p_origem and c.paciente_nome = v_prox order by c.criado_em limit 1;
  if v_conv is null then
    select count(*) into v_recentes from public.conversas where contato_id = o.contato_id and criado_em > now() - interval '1 hour';
    if v_recentes >= 5 then raise exception 'Muitas tentativas. Tente novamente em alguns minutos.' using errcode = '54000'; end if;
    insert into public.conversas (contato_id, nome_informado, email_informado, unidade_inicial, medico_preferido, paciente_tipo, paciente_nome, irmaos, irmaos_modo, irmao_de)
    values (o.contato_id, o.nome_informado, o.email_informado, o.unidade_inicial, o.medico_preferido, 'filho', v_prox, v_resto, o.irmaos_modo, o.id)
    returning id into v_conv;
    insert into public.conversa_segredo (conversa_id) values (v_conv) returning token into v_token;
    select * into src from public.pre_agendamentos where conversa_id = p_origem;
    if o.irmaos_modo = 'juntos' and src.id is not null
       and exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = p_origem and i.ativo) then
      insert into public.pre_agendamentos (conversa_id, tipo, especialidade, procedimento, plano, unidade, profissional, preferencia_horario, paciente, status, etapa)
      values (v_conv, src.tipo, src.especialidade, src.procedimento, src.plano, src.unidade, src.profissional, src.preferencia_horario, '{}'::jsonb, 'rascunho',
              case when src.plano is null then 'plano' else 'data_hora' end);
      insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento, quantidade)
      select v_conv, i.modalidade, i.regiao, i.regiao_nome, i.lado, i.procedimento_id, i.procedimento, i.quantidade
      from public.pre_agendamento_itens i where i.conversa_id = p_origem and i.ativo;
      v_copia := true;
    end if;
    v_msg := 'Agora vamos agendar para ' || v_prox
          || case when v_copia then ', com o mesmo pedido de ' || coalesce(o.paciente_nome, 'seu filho(a)') else '' end || '.';
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_msg);
  end if;
  return jsonb_build_object('conversa_id', v_conv, 'token', v_token, 'paciente_nome', v_prox, 'irmaos', v_resto, 'irmaos_modo', o.irmaos_modo);
end $function$;

