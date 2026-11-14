-- public.fluxo_marc_pergunta(p_conversa uuid, p_passo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_marc_pergunta(p_conversa uuid, p_passo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  d jsonb; ctx jsonb := public.fluxo_ctx(p_conversa); v_it jsonb := '[]'::jsonb; v_hoje date := (now() at time zone 'America/Bahia')::date; m record; v_sit text; v_txt text;
begin
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  case p_passo
  when 'marc_consultando' then
    if d ->> 'resultado_estado' = 'consultando' then
      return jsonb_build_object('texto', public.fluxo_t('resultado_consultando', ctx), 'op', jsonb_build_object('tipo', 'marcando', 'operacao', d ->> 'resultado_op', 'titulo', 'Conferindo o seu resultado…'));
    end if;
    return jsonb_build_object('texto', public.fluxo_t(case when d ->> 'marc_acao' = 'cancelando' then 'marc_cancelando' else 'marc_consultando' end, ctx),
      'op', jsonb_build_object('tipo', 'marcando', 'operacao', d ->> 'marc_op', 'titulo', case when d ->> 'marc_acao' = 'cancelando' then 'Cancelando…' else 'Consultando as suas marcações…' end));
  when 'marc_lista' then
    for m in select * from public.klingo_marcacao where conversa_id = p_conversa and situacao = 'ativa' and data >= v_hoje order by data, hora limit 8 loop
      v_it := v_it || jsonb_build_object('valor', 'm:' || m.voucher, 'rotulo', coalesce(nullif(m.procedimento, ''), 'Atendimento') || ' — ' || public.klingo_marc_quando(m.data, m.hora));
    end loop;
    v_it := v_it || jsonb_build_object('valor', 'nenhum', 'rotulo', 'Não é nenhuma destas');
    return jsonb_build_object('texto', public.fluxo_t('marc_lista', ctx), 'op', public.fluxo_escolha(p_passo, v_it));
  when 'marc_acao' then
    v_txt := public.klingo_marc_resumo(p_conversa, d ->> 'marc_voucher');
    return jsonb_build_object('texto', coalesce(v_txt || E'\n\n', '') || public.fluxo_t('marc_acao', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'cancelar', 'rotulo', 'Cancelar esta marcação'), jsonb_build_object('valor', 'remarcar', 'rotulo', 'Remarcar para outro horário'),
      jsonb_build_object('valor', 'outra', 'rotulo', 'Ver outra marcação'), jsonb_build_object('valor', 'equipe', 'rotulo', 'Falar com a equipe'),
      jsonb_build_object('valor', 'fim', 'rotulo', 'Está tudo certo, obrigado'))));
  when 'marc_cancelar' then
    return jsonb_build_object('texto', coalesce(public.klingo_marc_resumo(p_conversa, d ->> 'marc_voucher') || E'\n\n', '') || public.fluxo_t('marc_cancelar', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'cancelar_sim', 'rotulo', 'Sim, cancelar'), jsonb_build_object('valor', 'cancelar_nao', 'rotulo', 'Não, manter a marcação'))));
  when 'marc_vazio' then
    return jsonb_build_object('texto', public.fluxo_t('marc_vazio', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'nova', 'rotulo', 'Fazer uma nova marcação'), jsonb_build_object('valor', 'equipe', 'rotulo', 'Falar com a equipe'), jsonb_build_object('valor', 'fim', 'rotulo', 'Está tudo certo, obrigado'))));
  when 'marc_pos' then
    return jsonb_build_object('texto', public.fluxo_t('marc_pos', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'ver', 'rotulo', 'Ver minhas marcações'), jsonb_build_object('valor', 'nova', 'rotulo', 'Fazer uma nova marcação'), jsonb_build_object('valor', 'fim', 'rotulo', 'Está tudo certo, obrigado'))));
  when 'resultado_situacao' then
    return jsonb_build_object('texto', public.fluxo_t('resultado_situacao', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'pronto', 'rotulo', 'Saber se o meu resultado já está pronto'), jsonb_build_object('valor', 'acesso', 'rotulo', 'Receber o link ou a senha do resultado'),
      jsonb_build_object('valor', 'problema', 'rotulo', 'O resultado tem algum problema'), jsonb_build_object('valor', 'equipe', 'rotulo', 'Falar com a equipe'))));
  when 'resultado_orientacao' then
    v_sit := coalesce(d ->> 'resultado_situacao', 'pronto');
    v_txt := coalesce((select nullif(btrim(texto), '') from public.fluxo_texto where chave = 'resultado_orientacao_' || v_sit), (select nullif(btrim(texto), '') from public.fluxo_texto where chave = 'resultado_orientacao'));
    return jsonb_build_object('texto', v_txt, 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'equipe', 'rotulo', 'Chamar a equipe agora'), jsonb_build_object('valor', 'resolvido', 'rotulo', 'Era só isso, obrigado'))));
  else
    return jsonb_build_object('texto', public.fluxo_t('assunto_fim', ctx), 'op', jsonb_build_object('tipo', 'nova'));
  end case;
end $function$;

