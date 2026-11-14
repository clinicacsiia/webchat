-- public.klingo_autogestao()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_autogestao()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_m text := public.klingo_mestre(); v_hor text := public.klingo_modo_chave('klingo_api_horarios'); v_mar text := public.klingo_modo_chave('klingo_api_marcar');
  v_com7 bigint := public.klingo_medida_soma('horarios_api_com_horarios', 7); v_er7 bigint := public.klingo_medida_soma('horarios_api_erro', 7) + public.klingo_medida_soma('horarios_api_limite', 7);
  v_len7 bigint := public.klingo_medida_soma('horarios_ms_ge3s', 7); v_api7 bigint := public.klingo_medida_soma('sombra_api', 7); v_na7 bigint := public.klingo_medida_soma('sombra_api_na_grade', 7);
  v_ok1 bigint := public.klingo_medida_soma('horarios_api_ok', 1); v_er1 bigint := public.klingo_medida_soma('horarios_api_erro', 1) + public.klingo_medida_soma('horarios_api_limite', 1);
  v_rh timestamptz; v_rm timestamptz; v_rmest timestamptz; suc bigint; inc bigint; tec bigint; suc24 bigint; inc24 bigint; tec24 bigint; acoes text[] := '{}';
  v_tecnica constant text[] := array['plano_inativo', 'plano_desconhecido', 'sem_medico', 'nascimento_divergente', 'cadastro_divergente'];
begin
  if public.klingo_cfg('klingo_autogestao', 'sim') <> 'sim' then return jsonb_build_object('ligada', false); end if;
  if v_m = 'nao' then return jsonb_build_object('ligada', true, 'acoes', '[]'::jsonb, 'mestre', v_m); end if;
  select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
    into suc, inc, tec from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '30 days';
  select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
    into suc24, inc24, tec24 from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '24 hours';
  select max(em) into v_rmest from public.klingo_decisao where chave = 'klingo_auto' and para = 'teste';
  select max(em) into v_rh from public.klingo_decisao where chave = 'klingo_api_horarios' and para = 'sombra';
  select max(em) into v_rm from public.klingo_decisao where chave = 'klingo_api_marcar' and para = 'teste';

  if v_m in ('sim', 'legado') and (inc24 >= 2 or (tec24 >= 3 and tec24 * 5 >= suc24 + tec24 + inc24) or (v_er1 >= 20 and v_er1 * 2 >= v_ok1 + v_er1)) and (v_rmest is null or v_rmest < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_auto', 'teste', jsonb_build_object('incertas_24h', inc24, 'falhas_tecnicas_24h', tec24, 'sucessos_24h', suc24, 'erros_horarios_hoje', v_er1),
      'O autoatendimento do Klingo voltou para "só telefones de teste": houve marcações incertas, falhas técnicas ou a agenda do Klingo falhou demais. Confira as operações antes de liberar de novo.');
    acoes := array_append(acoes, 'mestre:recuou');
  end if;
  if v_hor = 'sim' and v_er1 >= 20 and v_er1 * 2 >= v_ok1 + v_er1 and (v_rh is null or v_rh < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_api_horarios', 'sombra', jsonb_build_object('erros_hoje', v_er1, 'ok_hoje', v_ok1), 'A agenda em tempo real do Klingo falhou em metade das consultas hoje; o chat parou de mostrar horários da API (pedido vai à equipe).');
    acoes := array_append(acoes, 'horarios:recuou');
  end if;
  if v_mar = 'sim' and (inc24 >= 2 or (tec24 >= 3 and tec24 * 5 >= suc24 + tec24 + inc24)) and (v_rm is null or v_rm < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_api_marcar', 'teste', jsonb_build_object('incertas_24h', inc24, 'falhas_tecnicas_24h', tec24, 'sucessos_24h', suc24), 'A marcação automática foi pausada (marcações incertas ou falhas técnicas demais nas últimas 24 h). Só os telefones de teste continuam. Confira as operações antes de liberar de novo.');
    acoes := array_append(acoes, 'marcar:recuou');
  end if;

  if v_hor = 'sombra' and v_com7 >= 30 and v_er7 * 20 <= v_com7 + v_er7 and v_len7 * 20 <= v_com7 and v_api7 >= 200 and v_na7 * 100 >= v_api7 * 85 then
    if public.klingo_recomendar('klingo_api_horarios', 'sim', jsonb_build_object('com_horarios_7d', v_com7, 'erros_7d', v_er7, 'lentos_7d', v_len7, 'api_7d', v_api7, 'api_na_grade_7d', v_na7),
         'Recomendação (nada foi alterado): a API de horários respondeu bem por 7 dias. Se concordar, o administrador pode liberar "horários" para os pacientes.') then
      acoes := array_append(acoes, 'horarios:recomendado');
    end if;
  end if;
  if v_mar = 'teste' and suc >= 20 and inc = 0 and suc * 100 >= (suc + tec) * 90 then
    if public.klingo_recomendar('klingo_api_marcar', 'sim', jsonb_build_object('sucessos_30d', suc, 'incertas_30d', inc, 'falhas_tecnicas_30d', tec),
         'Recomendação (nada foi alterado): 20 marcações de teste sem nenhuma incerta. É o mínimo do piloto, não prova de segurança; o administrador decide se libera para uma parte dos pacientes.') then
      acoes := array_append(acoes, 'marcar:recomendado');
    end if;
  end if;
  return jsonb_build_object('ligada', true, 'acoes', to_jsonb(acoes), 'mestre', v_m, 'horarios', v_hor, 'marcar', v_mar, 'percentual', public.klingo_cfg('klingo_api_percentual', '100'));
end $function$;

