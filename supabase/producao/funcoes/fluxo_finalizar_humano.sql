-- public.fluxo_finalizar_humano(p_conversa uuid, p_nota text, p_urgencia text, p_texto_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_finalizar_humano(p_conversa uuid, p_nota text DEFAULT NULL::text, p_urgencia text DEFAULT 'baixa'::text, p_texto_chave text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ctx jsonb := public.fluxo_ctx(p_conversa); v_on boolean := public.fluxo_equipe_online(); v_txt text; c public.conversas;
begin
  select * into c from public.conversas where id = p_conversa;
  ctx := ctx || jsonb_build_object('plano', coalesce((select pa.plano from public.pre_agendamentos pa where pa.conversa_id = p_conversa), ''));
  if p_nota is not null then perform public.fluxo_nota(p_conversa, p_nota); end if;
  perform public.fluxo_pre(p_conversa, '{"etapa": "pronto"}'::jsonb, true);
  update public.conversa_fluxo set passo = 'pronto', dados = dados || jsonb_build_object('enviado_em', now()), atualizado_em = now() where conversa_id = p_conversa;
  v_txt := public.fluxo_t(coalesce(p_texto_chave, case when v_on then 'pronto_online' else 'pronto_offline' end), ctx);
  if jsonb_array_length(coalesce(c.irmaos, '[]'::jsonb)) > 0 then v_txt := v_txt || E'\n\n' || public.fluxo_t('irmao_proximo', ctx); end if;
  perform public.fluxo_dizer(p_conversa, v_txt, jsonb_build_object('tipo', 'acompanhar'));
  perform public.fluxo_transferir(p_conversa, 'Pré-agendamento pronto (confirmado pelo paciente).', p_urgencia, false);
end $function$;

