-- public.klingo_autogestao()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_autogestao()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hor text := public.klingo_cfg('klingo_api_horarios', 'nao'); v_mar text := public.klingo_cfg('klingo_api_marcar', 'teste');
  v_pct integer := coalesce(nullif(public.klingo_cfg('klingo_api_percentual', '100'), '')::integer, 100);
  ok7 bigint := public.klingo_medida_soma('horarios_api_ok', 7); er7 bigint := public.klingo_medida_soma('horarios_api_erro', 7) + public.klingo_medida_soma('horarios_api_limite', 7);
  lento7 bigint := public.klingo_medida_soma('horarios_ms_ge3s', 7); api7 bigint := public.klingo_medida_soma('sombra_api', 7); na7 bigint := public.klingo_medida_soma('sombra_api_na_grade', 7);
  ok1 bigint := public.klingo_medida_soma('horarios_api_ok', 1); er1 bigint := public.klingo_medida_soma('horarios_api_erro', 1) + public.klingo_medida_soma('horarios_api_limite', 1);
  v_dh timestamptz; v_dm timestamptz; v_dp timestamptz; v_rh timestamptz; v_rm timestamptz; suc bigint; inc bigint; tec bigint; suc24 bigint; inc24 bigint; tec24 bigint; suc_p bigint; inc_p bigint; tec_p bigint; acoes text[] := '{}';
  v_m text;
  v_tecnica constant text[] := array['plano_inativo', 'plano_desconhecido', 'sem_medico', 'nascimento_divergente', 'cadastro_divergente'];   -- falha de regra de negócio não conta como falha técnica
begin
  if public.klingo_cfg('klingo_autogestao', 'sim') <> 'sim' then return jsonb_build_object('ligada', false); end if;
  -- INTERRUPTOR GERAL (parte 10): nao/teste = a automação não anda sozinha; sim = só vigia e RECUA para "teste" se algo piorar; legado = regras antigas por chave.
  v_m := public.klingo_mestre();
  if v_m in ('nao', 'teste') then return jsonb_build_object('ligada', true, 'acoes', '[]'::jsonb, 'mestre', v_m); end if;
  if v_m = 'sim' then
    select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
           count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
      into suc24, inc24, tec24 from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '24 hours';
    select max(em) into v_rm from public.klingo_decisao where chave = 'klingo_auto' and para = 'teste';
    if (inc24 >= 2 or (tec24 >= 3 and tec24 * 5 >= suc24 + tec24 + inc24) or (er1 >= 20 and er1 * 2 >= ok1 + er1)) and (v_rm is null or v_rm < now() - interval '30 minutes') then
      perform public.klingo_decidir('klingo_auto', 'teste', jsonb_build_object('incertas_24h', inc24, 'falhas_tecnicas_24h', tec24, 'sucessos_24h', suc24, 'erros_horarios_hoje', er1),
        'O autoatendimento do Klingo voltou para "só telefones de teste": houve marcações incertas, falhas técnicas ou a agenda do Klingo falhou demais. Os pacientes seguem pelo atendimento de sempre. Confira as operações antes de ligar de novo.');
      return jsonb_build_object('ligada', true, 'acoes', jsonb_build_array('mestre:recuou'), 'mestre', 'sim');
    end if;
    return jsonb_build_object('ligada', true, 'acoes', '[]'::jsonb, 'mestre', 'sim');
  end if;
  select max(em) into v_dh from public.klingo_decisao where chave = 'klingo_api_horarios';
  select max(em) into v_dm from public.klingo_decisao where chave = 'klingo_api_marcar';
  select max(em) into v_dp from public.klingo_decisao where chave = 'klingo_api_percentual';
  -- recuo é segurança: só é segurado por OUTRO recuo recente (evita oscilar), nunca por um avanço
  select max(em) into v_rh from public.klingo_decisao where chave = 'klingo_api_horarios' and para = 'sombra';
  select max(em) into v_rm from public.klingo_decisao where chave = 'klingo_api_marcar' and para = 'teste';

  -- horários
  if v_hor = 'sim' and er1 >= 20 and er1 * 2 >= ok1 + er1 and (v_rh is null or v_rh < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_api_horarios', 'sombra', jsonb_build_object('erros_hoje', er1, 'ok_hoje', ok1), 'A agenda em tempo real do Klingo falhou em metade das consultas hoje; o chat voltou a mostrar a grade (previsão). O sistema tenta de novo sozinho.');
    acoes := array_append(acoes, 'horarios:recuou');
  elsif v_hor = 'sombra' and ok7 >= 30 and er7 * 20 <= ok7 + er7 and lento7 * 20 <= ok7 and api7 >= 200 and na7 * 100 >= api7 * 85 and (v_dh is null or v_dh < now() - interval '1 day') then
    perform public.klingo_decidir('klingo_api_horarios', 'sim', jsonb_build_object('ok_7d', ok7, 'erros_7d', er7, 'lentos_7d', lento7, 'api_7d', api7, 'api_na_grade_7d', na7), 'O chat passou a mostrar os horários reais do Klingo (a API respondeu bem por 7 dias e bate com a grade).');
    acoes := array_append(acoes, 'horarios:avancou');
  end if;

  -- marcar sozinho (operações dos últimos 30 dias, 24 h e desde a última decisão)
  select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
    into suc, inc, tec from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '30 days';
  select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
    into suc24, inc24, tec24 from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '24 hours';
  if v_mar = 'sim' and (inc24 >= 2 or (tec24 >= 3 and tec24 * 5 >= suc24 + tec24 + inc24)) and (v_rm is null or v_rm < now() - interval '30 minutes') then
    perform public.klingo_decidir('klingo_api_marcar', 'teste', jsonb_build_object('incertas_24h', inc24, 'falhas_tecnicas_24h', tec24, 'sucessos_24h', suc24), 'A marcação automática foi pausada: houve marcações incertas ou falhas técnicas demais nas últimas 24 h. Só os telefones de teste continuam usando. Confira as operações antes de liberar de novo.');
    acoes := array_append(acoes, 'marcar:recuou');
    if public.klingo_cfg('klingo_api_pos', 'teste') = 'sim' then perform public.klingo_decidir('klingo_api_pos', 'teste', jsonb_build_object('motivo', 'a marcação automática recuou'), null); end if;
  elsif v_mar = 'teste' and suc >= 20 and inc = 0 and suc * 100 >= (suc + tec) * 90 and (v_dm is null or v_dm < now() - interval '1 day') then
    perform public.klingo_decidir('klingo_api_percentual', '10', jsonb_build_object('sucessos_30d', suc, 'falhas_tecnicas_30d', tec), null);
    perform public.klingo_decidir('klingo_api_marcar', 'sim', jsonb_build_object('sucessos_30d', suc, 'incertas_30d', inc, 'falhas_tecnicas_30d', tec), 'A marcação automática foi liberada para 10% das conversas (20 marcações de teste sem nenhuma incerta). O sistema aumenta sozinho se continuar bem.');
    acoes := array_append(acoes, 'marcar:avancou_10');
  elsif v_mar = 'sim' and v_pct < 100 and (v_dp is null or v_dp < now() - interval '2 days') then
    select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'), count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica) or coalesce(codigo, '') like 'divergencia%'))
      into suc_p, inc_p, tec_p from public.klingo_operacao where tipo = 'marcar' and criado_em > coalesce(v_dp, now() - interval '30 days');
    if suc_p >= 10 and inc_p = 0 and suc_p * 100 >= (suc_p + tec_p) * 95 then
      perform public.klingo_decidir('klingo_api_percentual', case when v_pct < 50 then '50' else '100' end, jsonb_build_object('sucessos', suc_p, 'falhas_tecnicas', tec_p), 'A marcação automática aumentou para ' || case when v_pct < 50 then '50%' else '100%' end || ' das conversas (taxa de sucesso alta e nenhuma incerta).');
      acoes := array_append(acoes, 'marcar:avancou_pct');
    end if;
  end if;
  if public.klingo_cfg('klingo_api_marcar', 'nao') = 'sim' and v_pct >= 100 and public.klingo_cfg('klingo_api_pos', 'teste') = 'teste' and v_dp is not null and v_dp < now() - interval '2 days'
     and not (acoes @> array['marcar:avancou_pct']) and not (acoes @> array['marcar:recuou']) then
    perform public.klingo_decidir('klingo_api_pos', 'sim', jsonb_build_object('percentual', v_pct), 'Cancelar e remarcar pelo chat foram liberados (a marcação automática já está em 100% e estável).');
    acoes := array_append(acoes, 'pos:avancou');
  end if;
  return jsonb_build_object('ligada', true, 'acoes', to_jsonb(acoes), 'horarios', v_hor, 'marcar', v_mar, 'percentual', v_pct);
end $function$;

