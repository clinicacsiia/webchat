-- Parte 5: função nova. O médico escolhido não tem horário em 45 dias: abre a solicitação de disponibilidade futura (previsão) só com ele(a), para a atendente avaliar.
-- Aceita_notificacao = false de propósito: a equipe avalia e fala com o paciente (o aviso automático ao paciente continua só para quem marca "quero ser avisado" no formulário).
create or replace function public.chat_medico_sem_horario_abrir(p_conversa uuid, p_token text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_pref text; v_nome text; v_r jsonb; v_texto text; v_prox text;
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  if not public.klingo_ativo(p_conversa, 'previsao_modo') then raise exception 'Este recurso ainda não está disponível para você. A equipe pode ajudar.' using errcode = 'P0001'; end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  select c.medico_preferido into v_pref from public.conversas c where c.id = p_conversa;
  if v_pref is null then raise exception 'Este pedido não tem médico escolhido.' using errcode = 'P0001'; end if;
  -- só abre quando a API realmente não ofereceu nenhum horário futuro desse médico
  if exists (select 1 from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > (now() at time zone 'America/Bahia')
              and public.klingo_prof_confere(o.profissional, v_pref)) then
    raise exception 'Há horários desse médico na lista. Escolha um deles.' using errcode = 'P0001';
  end if;
  v_nome := initcap(lower(v_pref));
  v_r := public.disponibilidade_gravar(p_conversa, jsonb_build_object('data_ini', current_date, 'data_fim', current_date + 60, 'turno', 'qualquer', 'profissional', v_pref,
           'aceita_outros_profissionais', false, 'aceita_outras_unidades', true, 'aceita_notificacao', false, 'canais', '[]'::jsonb));
  v_texto := v_nome || ' não tem horário disponível nos próximos 45 dias.'
    || E'\n\nAbri uma solicitação (previsão) aqui no chat para a nossa equipe avaliar e falar com você sobre ' || v_nome || '. Mantivemos a sua escolha: não vamos trocar de médico.'
    || E'\n\nIsso NÃO é um agendamento e não reserva horário.';
  perform public.fluxo_dizer(p_conversa, v_texto, jsonb_build_object('tipo', 'disponibilidade_registrada', 'id', v_r ->> 'id'));
  perform public.fluxo_set(p_conversa, jsonb_build_object('sem_horario', true, 'disponibilidade', v_r ->> 'id'));
  perform public.fluxo_nota(p_conversa, 'MÉDICO ESCOLHIDO SEM HORÁRIO em 45 dias na API do Klingo (' || v_nome || '). O paciente NÃO aceita outro médico. Previsão aberta só com esse médico: avalie a agenda do Klingo (encaixe, nova agenda) e responda.');
  v_prox := public.fluxo_proximo(p_conversa);
  if v_prox = 'pronto' then perform public.fluxo_finalizar(p_conversa); else perform public.fluxo_perguntar(p_conversa, v_prox, null); end if;
  return jsonb_build_object('ok', true, 'solicitacao', v_r);
end $function$;

revoke all on function public.chat_medico_sem_horario_abrir(uuid, text) from public;
grant execute on function public.chat_medico_sem_horario_abrir(uuid, text) to anon, authenticated, service_role;
