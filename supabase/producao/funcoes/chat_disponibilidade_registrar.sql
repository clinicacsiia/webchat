-- public.chat_disponibilidade_registrar(p_conversa uuid, p_token text, p_dados jsonb)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_disponibilidade_registrar(p_conversa uuid, p_token text, p_dados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_r jsonb; v_texto text; v_prox text; v_pref text; v_dados jsonb := coalesce(p_dados, '{}'::jsonb);
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  if not public.klingo_ativo(p_conversa, 'previsao_modo') then raise exception 'Este recurso ainda não está disponível para você. A equipe pode ajudar.' using errcode = 'P0001'; end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  -- médico escolhido pelo paciente: a solicitação é só com ele(a)
  select c.medico_preferido into v_pref from public.conversas c where c.id = p_conversa;
  if v_pref is not null then v_dados := v_dados || jsonb_build_object('profissional', v_pref, 'aceita_outros_profissionais', false); end if;
  v_r := public.disponibilidade_gravar(p_conversa, v_dados);
  v_texto := 'Registrei a sua disponibilidade para ' || coalesce(v_r ->> 'procedimento', 'o atendimento') || ', de ' || to_char((v_r ->> 'data_ini')::date, 'DD/MM') || ' a ' || to_char((v_r ->> 'data_fim')::date, 'DD/MM') || '.'
    || E'\n\nIsso NÃO é um agendamento e não reserva horário: é um pedido para avisarmos você quando surgir uma vaga compatível. '
    || case when (v_r ->> 'aceita_notificacao')::boolean then 'Quando isso acontecer, você receberá um aviso aqui no chat e poderá tentar agendar na hora.' else 'Você não autorizou avisos; para acompanhar, volte aqui e toque em "Minha disponibilidade".' end;
  perform public.fluxo_dizer(p_conversa, v_texto, jsonb_build_object('tipo', 'disponibilidade_registrada', 'id', v_r ->> 'id'));
  perform public.fluxo_set(p_conversa, jsonb_build_object('sem_horario', true, 'disponibilidade', v_r ->> 'id'));
  perform public.fluxo_nota(p_conversa, 'SOLICITAÇÃO DE DISPONIBILIDADE FUTURA registrada (NÃO é agendamento e não reserva horário). Procura automática de vaga: ativa. Nada a fazer pela equipe agora.');
  v_prox := public.fluxo_proximo(p_conversa);
  if v_prox = 'pronto' then perform public.fluxo_finalizar(p_conversa); else perform public.fluxo_perguntar(p_conversa, v_prox, null); end if;
  if public.klingo_cfg('disponibilidade_encerra_conversa', 'nao') = 'sim' and not exists (select 1 from public.klingo_operacao o where o.conversa_id = p_conversa and o.estado in ('pendente', 'executando', 'incerto')) then
    update public.conversas set status = 'encerrada', encerrada_em = now(), motivo_encerramento = 'outro', encerramento_origem = 'sistema' where id = p_conversa and status <> 'encerrada' and primeiro_humano_em is null;
  end if;
  return jsonb_build_object('ok', true, 'solicitacao', v_r);
end $function$;

