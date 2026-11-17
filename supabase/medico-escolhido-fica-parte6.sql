-- Parte 6 (17/11/2026, pedido do dono): ao abrir a solicitação, o paciente DIGITA os dias da semana, o turno e até que dia pode ir. A função nova recebe esses dados (p_dados).
-- A de 2 parâmetros (parte 5) usava valores padrão e sai (parte 6b); ela nunca foi chamada por tela publicada.
create or replace function public.chat_medico_sem_horario_abrir(p_conversa uuid, p_token text, p_dados jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare v_pref text; v_nome text; v_r jsonb; v_texto text; v_prox text; v_d jsonb := coalesce(p_dados, '{}'::jsonb); v_turno text; v_dias text; v_ini date; v_fim date;
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
  if nullif(v_d ->> 'data_fim', '') is null then raise exception 'Informe até que dia você pode ir.' using errcode = '22023'; end if;
  -- só abre quando a API realmente não ofereceu nenhum horário futuro desse médico
  if exists (select 1 from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and (o.data + o.hora::time) > (now() at time zone 'America/Bahia')
              and public.klingo_prof_confere(o.profissional, v_pref)) then
    raise exception 'Há horários desse médico na lista. Escolha um deles.' using errcode = 'P0001';
  end if;
  v_nome := initcap(lower(v_pref));
  -- o médico é sempre o escolhido; o resto (período, dias, turno, unidade, aviso) é o que o paciente informou
  v_r := public.disponibilidade_gravar(p_conversa, v_d || jsonb_build_object('profissional', v_pref, 'aceita_outros_profissionais', false));
  v_ini := (v_r ->> 'data_ini')::date; v_fim := (v_r ->> 'data_fim')::date;
  v_turno := case v_r ->> 'turno' when 'manha' then 'de manhã' when 'tarde' then 'à tarde' when 'noite' then 'à noite' else 'em qualquer horário' end;
  v_dias := case when jsonb_array_length(v_r -> 'dias_semana') >= 7 then 'qualquer dia da semana'
                 else (select string_agg((array['dom','seg','ter','qua','qui','sex','sáb'])[x::int + 1], ', ' order by x::int) from jsonb_array_elements_text(v_r -> 'dias_semana') x) end;
  v_texto := v_nome || ' não tem horário disponível nos próximos 45 dias.'
    || E'\n\nAbri uma solicitação (previsão) aqui no chat para a nossa equipe avaliar e falar com você sobre ' || v_nome || '. Você pode ir de ' || to_char(v_ini, 'DD/MM') || ' até ' || to_char(v_fim, 'DD/MM') || ', ' || v_turno || ', ' || v_dias || '. Mantivemos a sua escolha: não vamos trocar de médico.'
    || E'\n\nIsso NÃO é um agendamento e não reserva horário.';
  perform public.fluxo_dizer(p_conversa, v_texto, jsonb_build_object('tipo', 'disponibilidade_registrada', 'id', v_r ->> 'id'));
  perform public.fluxo_set(p_conversa, jsonb_build_object('sem_horario', true, 'disponibilidade', v_r ->> 'id'));
  perform public.fluxo_nota(p_conversa, 'MÉDICO ESCOLHIDO SEM HORÁRIO em 45 dias na API do Klingo (' || v_nome || '). O paciente NÃO aceita outro médico. Disponível: ' || to_char(v_ini, 'DD/MM') || ' a ' || to_char(v_fim, 'DD/MM') || ', ' || v_turno || ', ' || v_dias || '. Avalie a agenda do Klingo (encaixe, nova agenda) e responda.');
  v_prox := public.fluxo_proximo(p_conversa);
  if v_prox = 'pronto' then perform public.fluxo_finalizar(p_conversa); else perform public.fluxo_perguntar(p_conversa, v_prox, null); end if;
  return jsonb_build_object('ok', true, 'solicitacao', v_r);
end $function$;

revoke all on function public.chat_medico_sem_horario_abrir(uuid, text, jsonb) from public;
grant execute on function public.chat_medico_sem_horario_abrir(uuid, text, jsonb) to anon, authenticated, service_role;
