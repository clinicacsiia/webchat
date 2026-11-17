-- Parte 4b: alterar também mantém o médico escolhido
CREATE OR REPLACE FUNCTION public.chat_disponibilidade_alterar(p_conversa uuid, p_token text, p_id uuid, p_dados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.disponibilidade_pedido; v_r jsonb; v_pref text; v_dados jsonb := coalesce(p_dados, '{}'::jsonb);
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  perform public.chat_valida(p_conversa, p_token);
  r := public.disponibilidade_do_paciente(p_conversa, p_id);
  if r.estado in ('expirada', 'cancelada', 'convertida_em_agendamento') then raise exception 'Esta solicitação já terminou. Faça uma nova.' using errcode = 'P0001'; end if;
  select c.medico_preferido into v_pref from public.conversas c where c.id = p_conversa;
  if v_pref is not null then v_dados := v_dados || jsonb_build_object('profissional', v_pref, 'aceita_outros_profissionais', false); end if;
  v_r := public.disponibilidade_gravar(p_conversa, v_dados || jsonb_build_object('unidade', coalesce(p_dados ->> 'unidade', r.unidade)), r.id);
  return jsonb_build_object('ok', true, 'solicitacao', v_r);
end $function$;
