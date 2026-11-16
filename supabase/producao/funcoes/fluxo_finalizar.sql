-- public.fluxo_finalizar(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_finalizar(p_conversa uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ctx jsonb := public.fluxo_ctx(p_conversa); v_pode jsonb; v_op uuid; v_rem jsonb; pa public.pre_agendamentos; v_vr jsonb;
begin
  select f.dados -> 'remarcando' into v_rem from public.conversa_fluxo f where f.conversa_id = p_conversa;
  -- particular-valor: recusou o valor = equipe avisada, nada é cadastrado no Klingo; sem preço = pendência da equipe responder o valor
  if public.particular_valor_ativo(p_conversa) then
    select f.dados -> 'valor_resp' into v_vr from public.conversa_fluxo f where f.conversa_id = p_conversa;
    if (v_vr ->> 'assin') is not distinct from public.particular_valor_assinatura(p_conversa) then
      if v_vr ->> 'resp' = 'recusado' then
        perform public.fluxo_dizer(p_conversa, public.fluxo_t('valor_recusado_equipe', ctx), jsonb_build_object('tipo', 'acompanhar'));
        perform public.fluxo_transferir(p_conversa, 'VALOR RECUSADO: o paciente viu o valor Particular (' || public.preco_brl((v_vr ->> 'total')::numeric) || ') e NÃO quis marcar. Nada foi cadastrado no Klingo. Conversar sobre outras opções.', 'media', false);
        return;
      elsif v_vr ->> 'resp' = 'quer_valor' then
        perform public.fluxo_finalizar_humano(p_conversa, 'PENDENTE: o paciente quer saber o VALOR do atendimento Particular (a API não trouxe o preço). Informar o valor aqui; só marcar se ele concordar.', 'media', 'valor_quer_equipe');
        return;
      elsif v_vr ->> 'resp' = 'dispensou' then
        perform public.fluxo_finalizar_humano(p_conversa, 'Particular sem preço na API; o paciente não pediu o valor agora. Marcação feita pela equipe.', 'baixa', 'valor_dispensou_equipe');
        return;
      end if;
    end if;
  end if;
  begin v_pode := public.klingo_pode_marcar(p_conversa); exception when others then v_pode := jsonb_build_object('ok', false, 'motivo', 'erro_interno'); end;
  if coalesce((v_pode ->> 'ok')::boolean, false) then
    begin
      v_op := public.klingo_operacao_criar(p_conversa);
      update public.conversa_fluxo set passo = 'marcando', dados = dados || jsonb_build_object('enviado_em', now(), 'operacao', v_op), atualizado_em = now() where conversa_id = p_conversa;
      perform public.fluxo_dizer(p_conversa, public.fluxo_t(case when jsonb_typeof(v_rem) = 'object' then 'remarcando' else 'marcando' end, ctx), jsonb_build_object('tipo', 'marcando', 'operacao', v_op));
      return;
    exception when others then null;
    end;
  end if;
  if jsonb_typeof(v_rem) = 'object' then
    select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
    perform public.fluxo_nota(p_conversa, 'Remarcação pedida pelo chat, mas a automação não pôde fazer (' || coalesce(v_pode ->> 'motivo', '?') || coalesce(' — ' || (v_pode ->> 'detalhe'), '') || '). O agendamento atual (voucher ' || coalesce(v_rem ->> 'voucher', '?') || ') continua valendo; novo horário escolhido: '
      || coalesce((pa.escolha_horario -> 0 ->> 'data') || ' ' || (pa.escolha_horario -> 0 ->> 'hora'), 'nenhum') || '.');
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('marcar_equipe', ctx));
    perform public.fluxo_transferir(p_conversa, 'Paciente quer remarcar o agendamento (novo horário escolhido no chat).', 'baixa', false);
    update public.conversa_fluxo set dados = dados - 'remarcando', atualizado_em = now() where conversa_id = p_conversa;
    return;
  end if;
  perform public.fluxo_finalizar_humano(p_conversa, case when coalesce(v_pode ->> 'motivo', 'desligado') in ('desligado', 'ja_agendado') then null
    else 'Automação não aplicada: ' || (v_pode ->> 'motivo') || coalesce(' — ' || (v_pode ->> 'detalhe'), '') end);
end $function$;

