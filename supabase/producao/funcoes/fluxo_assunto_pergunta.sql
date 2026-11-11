-- public.fluxo_assunto_pergunta(p_conversa uuid, p_passo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_assunto_pergunta(p_conversa uuid, p_passo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; ctx jsonb := public.fluxo_ctx(p_conversa); v_it jsonb := '[]'::jsonb; f jsonb;
begin
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  case p_passo
  when 'assunto_qual' then
    for f in select value from jsonb_array_elements(public.fluxo_assunto_futuros(p_conversa)) loop
      v_it := v_it || jsonb_build_object('valor', 'i' || (f ->> 'idx'), 'rotulo', f ->> 'rotulo');
    end loop;
    v_it := v_it || jsonb_build_object('valor', 'nenhum', 'rotulo', 'Não é nenhum destes');
    return jsonb_build_object('texto', public.fluxo_t('assunto_qual_' || lower(coalesce(d ->> 'assunto', 'remarcar')), ctx), 'op', public.fluxo_escolha(p_passo, v_it));
  when 'assunto_confirma' then
    return jsonb_build_object('texto', public.fluxo_t('assunto_confirma', ctx || jsonb_build_object('item', coalesce(d ->> 'assunto_item', 'este horário'))),
      'op', public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'sim', 'rotulo', 'Sim, cancelar'), jsonb_build_object('valor', 'nao', 'rotulo', 'Não, voltar'))));
  when 'assunto_resultado' then
    return jsonb_build_object('texto', (select btrim(texto) from public.fluxo_texto where chave = 'resultado_orientacao'),
      'op', public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'resolvido', 'rotulo', 'Resolveu, obrigado'), jsonb_build_object('valor', 'atendente', 'rotulo', 'Preciso de um atendente'))));
  else
    return jsonb_build_object('texto', public.fluxo_t('assunto_fim', ctx), 'op', jsonb_build_object('tipo', 'nova'));
  end case;
end $function$;

