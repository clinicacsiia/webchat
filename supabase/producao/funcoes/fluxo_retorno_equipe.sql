-- public.fluxo_retorno_equipe(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_retorno_equipe(p_conversa uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_ok jsonb := public.retorno_recente_ok(p_conversa); ctx jsonb;
begin
  ctx := public.fluxo_ctx(p_conversa) || jsonb_build_object('especialidade', coalesce(v_ok ->> 'especialidade', 'mesma especialidade'), 'dias', coalesce(v_ok ->> 'limite', '30'));
  perform public.fluxo_dizer(p_conversa, public.fluxo_t('retorno_equipe', ctx), jsonb_build_object('tipo', 'acompanhar'));
  perform public.fluxo_transferir(p_conversa, 'RETORNO EM MENOS DE ' || coalesce(v_ok ->> 'limite', '30') || ' DIAS: já atendido(a) em consulta de ' || coalesce(v_ok ->> 'especialidade', '?')
    || ' há ' || coalesce(v_ok ->> 'dias_desde', '?') || ' dia(s) (' || coalesce(to_char((v_ok ->> 'ultimo_em')::date, 'DD/MM/YYYY'), '?') || ', pelo Klingo). Nada foi marcado. Conferir se é retorno e agendar com o paciente.', 'media', false);
end $function$;

