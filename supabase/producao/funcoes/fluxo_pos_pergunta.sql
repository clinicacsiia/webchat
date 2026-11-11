-- public.fluxo_pos_pergunta(p_conversa uuid, p_passo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_pos_pergunta(p_conversa uuid, p_passo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; ctx jsonb := public.fluxo_ctx(p_conversa);
begin
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  ctx := ctx || jsonb_build_object('item', coalesce(d ->> 'pos_item', 'o seu exame'));
  if p_passo = 'exame_aberto' then
    return jsonb_build_object('texto', public.fluxo_t('exame_aberto', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'compareceu', 'rotulo', 'Fui e fiz o exame'),
      jsonb_build_object('valor', 'faltei', 'rotulo', 'Não consegui ir'),
      jsonb_build_object('valor', 'cancelar', 'rotulo', 'Quero cancelar'),
      jsonb_build_object('valor', 'remarcar', 'rotulo', 'Quero remarcar para outro dia'))));
  end if;
  return jsonb_build_object('texto', public.fluxo_t('remarcar_falta', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
    jsonb_build_object('valor', 'sim', 'rotulo', 'Sim, remarcar agora'),
    jsonb_build_object('valor', 'atendente', 'rotulo', 'Prefiro falar com um atendente'),
    jsonb_build_object('valor', 'nao', 'rotulo', 'Não quero remarcar'))));
end $function$;

