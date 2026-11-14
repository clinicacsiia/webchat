-- public.klingo_resultados_aplicar(p_op uuid, p_estado text, p_r jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_resultados_aplicar(p_op uuid, p_estado text, p_r jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare op public.klingo_operacao; v_cod text := left(p_r ->> 'codigo', 60); v_pos text; v_txt text; v_lista text; ctx jsonb;
begin
  select * into op from public.klingo_operacao where id = p_op;
  ctx := public.fluxo_ctx(op.conversa_id);
  select passo into v_pos from public.conversa_fluxo where conversa_id = op.conversa_id;
  if v_pos is distinct from 'marc_consultando' then return jsonb_build_object('ok', true, 'estado', p_estado); end if;
  if p_estado = 'sucesso' and jsonb_typeof(p_r -> 'resultados') = 'array' then
    select string_agg('• ' || coalesce(nullif(x.procedimento, ''), 'Exame') || coalesce(' de ' || to_char(case when x.data ~ '^\d{4}-\d{2}-\d{2}' then substr(x.data, 1, 10)::date end, 'DD/MM'), '') || ': '
                      || case when x.pronto is true then 'resultado liberado' when x.pronto is false then 'ainda não liberado' else 'não consegui conferir' end, E'\n')
      into v_lista from jsonb_to_recordset(p_r -> 'resultados') as x(procedimento text, data text, pronto boolean);
    v_txt := case when v_lista is null then 'Não encontrei exame realizado recentemente no cadastro' || (ctx ->> 'de_quem') || '.' else 'Conferi no sistema da clínica:' || E'\n' || v_lista end;
    perform public.fluxo_set(op.conversa_id, jsonb_build_object('resultado_estado', 'mostrado'));
    perform public.fluxo_perguntar(op.conversa_id, 'resultado_orientacao', v_txt);
    return jsonb_build_object('ok', true, 'estado', 'sucesso');
  end if;
  if v_cod in ('nascimento_divergente', 'sessao_nao_confere', 'dados_incompletos', 'sem_id_definitivo', 'cadastro_nao_encontrado') or v_cod like 'divergencia_%' then
    perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('marc_identidade', ctx));
    perform public.fluxo_transferir(op.conversa_id, 'Paciente quis saber do resultado de exame e a identidade não foi confirmada no Klingo (' || coalesce(v_cod, 'falha') || ').', 'baixa', true);
    return jsonb_build_object('ok', true, 'estado', p_estado);
  end if;
  perform public.fluxo_set(op.conversa_id, jsonb_build_object('resultado_estado', 'falha'));
  perform public.fluxo_nota(op.conversa_id, 'Consulta de resultado ao Klingo não concluída (' || coalesce(v_cod, 'falha') || ').');
  perform public.fluxo_perguntar(op.conversa_id, 'resultado_orientacao', 'Não consegui conferir o sistema da clínica agora, então não sei dizer se o seu resultado já foi liberado.');
  return jsonb_build_object('ok', true, 'estado', p_estado);
end $function$;

