-- public.fluxo_finalizar(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_finalizar(p_conversa uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ctx jsonb := public.fluxo_ctx(p_conversa); v_pode jsonb; v_op uuid; v_rem jsonb; pa public.pre_agendamentos;
begin
  select f.dados -> 'remarcando' into v_rem from public.conversa_fluxo f where f.conversa_id = p_conversa;
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

