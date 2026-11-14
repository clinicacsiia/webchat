-- public.klingo_consulta_registrar(p_conversa uuid, p_modo text, p_tipo text, p_procedimento integer, p_plano integer, p_resultado text, p_http integer, p_recebidos integer, p_validos integer, p_filtrados integer, p_gravados integer, p_ms integer, p_detalhe text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_consulta_registrar(p_conversa uuid, p_modo text, p_tipo text, p_procedimento integer, p_plano integer, p_resultado text, p_http integer DEFAULT NULL::integer, p_recebidos integer DEFAULT NULL::integer, p_validos integer DEFAULT NULL::integer, p_filtrados integer DEFAULT NULL::integer, p_gravados integer DEFAULT NULL::integer, p_ms integer DEFAULT NULL::integer, p_detalhe text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.klingo_consulta (conversa_id, modo, tipo, procedimento, plano, resultado, http_status, n_recebidos, n_validos, n_filtrados, n_gravados, ms, detalhe)
  values (p_conversa, left(p_modo, 12), left(p_tipo, 12), p_procedimento, p_plano, p_resultado, p_http, p_recebidos, p_validos, p_filtrados, p_gravados, p_ms, left(p_detalhe, 200));
  perform public.klingo_medir(case when p_modo = 'monitor' then 'monitor_' else 'consulta_' end || p_resultado);
  if p_modo = 'monitor' then return; end if;
  if p_resultado in ('ok_com_horarios', 'api_sem_horarios', 'todos_filtrados') then perform public.klingo_medir('horarios_api_ok', 1, p_ms); end if;
  if p_resultado = 'ok_com_horarios' then perform public.klingo_medir('horarios_api_com_horarios'); end if;
  if p_resultado = 'api_sem_horarios' then perform public.klingo_medir('horarios_api_sem_horarios'); end if;
  if p_resultado = 'estrutura_invalida' then perform public.klingo_medir('horarios_api_estrutura_invalida'); end if;
  if p_resultado = 'todos_filtrados' then perform public.klingo_medir('horarios_api_filtrados'); end if;
  if p_resultado = 'erro_api' then perform public.klingo_medir('horarios_api_erro'); end if;
  if p_resultado = 'limite' then perform public.klingo_medir('horarios_api_limite'); end if;
  if p_resultado = 'erro_gravacao' then perform public.klingo_medir('horarios_api_erro_gravacao'); end if;
  if p_resultado = 'ok_com_horarios' and p_ms is not null then
    perform public.klingo_medir(case when p_ms < 1000 then 'horarios_ms_lt1s' when p_ms < 3000 then 'horarios_ms_lt3s' else 'horarios_ms_ge3s' end);
  end if;
end $function$;

