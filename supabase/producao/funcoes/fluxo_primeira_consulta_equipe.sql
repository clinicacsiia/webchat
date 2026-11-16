-- public.fluxo_primeira_consulta_equipe(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_primeira_consulta_equipe(p_conversa uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ctx jsonb := public.fluxo_ctx(p_conversa); v_ok jsonb := public.primeira_consulta_ok(p_conversa);
begin
  perform public.fluxo_dizer(p_conversa, public.fluxo_t('primeira_consulta_equipe', ctx), jsonb_build_object('tipo', 'acompanhar'));
  perform public.fluxo_transferir(p_conversa, 'PRIMEIRA CONSULTA com a médica (' || coalesce(v_ok ->> 'motivo', '?') || '): o Klingo não mostra atendimento anterior dele(a) com ela. Nada foi marcado. Conferir; se já foi atendido(a), use "Liberar autoatendimento" e marque, senão agende a primeira consulta.', 'media', false);
end $function$;

