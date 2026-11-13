-- FLUXOGRAMA: entrada (passo previsao_decide) -> validação (só muda o rótulo do botão; o valor 'lista' continua o mesmo) -> saída (botão sem a palavra "previsão").
-- Versão 1.0 — 13/11/2026 / Mudança: rótulo "Quero ficar na lista de previsão" passa a "Quero ficar na lista de espera".
-- ROLLBACK: reaplicar supabase/producao/funcoes/previsao_pergunta.sql.
CREATE OR REPLACE FUNCTION public.previsao_pergunta(p_conversa uuid, p_passo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_txt text; v_itens jsonb;
begin
  case p_passo
  when 'previsao_turno' then
    v_txt := 'Vamos encontrar o melhor horário para você. Qual turno você prefere?';
    v_itens := jsonb_build_array(jsonb_build_object('valor', 'manha', 'rotulo', 'Manhã'), jsonb_build_object('valor', 'tarde', 'rotulo', 'Tarde'), jsonb_build_object('valor', 'qualquer', 'rotulo', 'Tanto faz'));
  when 'previsao_periodo' then
    v_txt := 'Para quando você quer o atendimento?';
    v_itens := jsonb_build_array(jsonb_build_object('valor', 'quinze', 'rotulo', 'Nos próximos 15 dias'), jsonb_build_object('valor', 'mes', 'rotulo', 'Ainda neste mês'),
      jsonb_build_object('valor', 'proximo_mes', 'rotulo', 'No mês que vem'), jsonb_build_object('valor', 'tres_meses', 'rotulo', 'Daqui a 2 ou 3 meses'), jsonb_build_object('valor', 'depois', 'rotulo', 'Mais para frente'));
  when 'previsao_decide' then
    v_txt := coalesce((select valor from public.config where chave = 'previsao_decide_texto'), '');
    v_itens := jsonb_build_array(jsonb_build_object('valor', 'lista', 'rotulo', 'Quero ficar na lista de espera'), jsonb_build_object('valor', 'calendario', 'rotulo', 'Prefiro escolher outra data no calendário'));
  when 'previsao_antecedencia' then
    v_txt := 'Se surgir uma vaga, com quanto tempo de antecedência você consegue ser chamado?';
    v_itens := jsonb_build_array(jsonb_build_object('valor', 'imediato', 'rotulo', 'Posso ir em até 24 horas'), jsonb_build_object('valor', '1_dia', 'rotulo', 'Preciso de 1 dia de antecedência'),
      jsonb_build_object('valor', '1_semana', 'rotulo', 'Preciso de 1 semana de antecedência'), jsonb_build_object('valor', '1_mes', 'rotulo', 'Preciso de 1 mês de antecedência'));
  else v_txt := 'Como podemos continuar?'; v_itens := '[]'::jsonb;
  end case;
  return jsonb_build_object('texto', v_txt, 'opcoes', public.fluxo_escolha(p_passo, v_itens));
end $function$
;
