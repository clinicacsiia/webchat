-- FLUXOGRAMA: entrada (o dono muda "klingo_auto" em Configurações: nao | teste | sim; telefones de teste em klingo_api_telefones_teste) -> validação (valor desconhecido vale "nao"; chave individual em "nao" desliga só aquela função) -> lógica (nao: nenhum paciente usa a API, tudo como antes; teste: só os telefones da lista usam TODAS as funções; sim: todos usam; a autogestão, em "sim", só vigia e volta sozinha para "teste" se piorar; "legado" = regras antigas por chave) -> saída (klingo_ativo decide para o chat, o executor e as Edge Functions; decisão registrada em klingo_decisao e aviso à gestão)
-- Versão 1.0 — 12/11/2026 / Mudança: pedido do dono (começar desativado, um botão liga tudo, telefones de teste, voltar ao antigo se der problema). Não altera tabelas nem assinaturas.
-- ROLLBACK: recriar klingo_ativo e klingo_autogestao a partir de supabase/producao/funcoes/ no commit cabcd6f e apagar klingo_mestre().
-- APLICAR EM PARTES (a ferramenta expira em 60 s): 1) config + klingo_mestre + klingo_ativo; 2) klingo_autogestao; 3) painel_automacao_resumo (mostra o interruptor geral).

-- Parte 1
insert into public.config (chave, valor) values ('klingo_auto', 'nao') on conflict (chave) do nothing;

CREATE OR REPLACE FUNCTION public.klingo_mestre()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$ select case when m in ('teste', 'sim', 'legado') then m else 'nao' end from (select coalesce((select valor from public.config where chave = 'klingo_auto'), 'nao') as m) x $function$;
REVOKE ALL ON FUNCTION public.klingo_mestre() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.klingo_mestre() TO service_role;

CREATE OR REPLACE FUNCTION public.klingo_ativo(p_conversa uuid, p_chave text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_m text := public.klingo_mestre(); v_modo text := public.klingo_cfg(p_chave, 'nao'); v_tel text; v_pct integer; v_lista boolean := false;
begin
  if v_m = 'nao' then return false; end if;
  select right(regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g'), 8) into v_tel
    from public.conversas c join public.contatos ct on ct.id = c.contato_id where c.id = p_conversa;
  if v_tel is not null and length(v_tel) = 8 then
    v_lista := exists (select 1 from regexp_split_to_table(public.klingo_cfg('klingo_api_telefones_teste', ''), '[^0-9]+') t where length(t) >= 8 and right(t, 8) = v_tel);
  end if;
  if v_m = 'teste' then return v_modo <> 'nao' and v_lista; end if;       -- só os telefones da lista, em todas as funções
  if v_m = 'sim' then return v_modo <> 'nao'; end if;                       -- todos os pacientes
  -- legado: regras antigas por chave
  if v_modo not in ('teste', 'sim') then return false; end if;
  if v_lista then return true; end if;
  if v_modo = 'teste' then return false; end if;
  v_pct := least(100, greatest(0, coalesce(nullif(public.klingo_cfg('klingo_api_percentual', '100'), '')::integer, 100)));
  return (abs(hashtext(p_conversa::text)) % 100) < v_pct;
exception when others then return false;
end $function$;

-- Parte 2
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
           count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica)))
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
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica)))
    into suc, inc, tec from public.klingo_operacao where tipo = 'marcar' and criado_em > now() - interval '30 days';
  select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'),
         count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica)))
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
    select count(*) filter (where estado = 'sucesso'), count(*) filter (where estado = 'incerto'), count(*) filter (where estado = 'falha' and not (coalesce(codigo, '') = any (v_tecnica)))
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

-- Parte 3
CREATE OR REPLACE FUNCTION public.painel_automacao_resumo(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date; v_ate date; v_de date; v_dias integer;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem estes números.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje); v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400); v_dias := greatest(v_ate - v_de + 1, 1);
  return jsonb_build_object(
    'modos', jsonb_build_object('mestre', public.klingo_mestre(), 'horarios', public.klingo_cfg('klingo_api_horarios', 'nao'), 'marcar', public.klingo_cfg('klingo_api_marcar', 'nao'), 'percentual', public.klingo_cfg('klingo_api_percentual', '100'),
                                'pre_cadastro', public.klingo_cfg('klingo_api_pre_cadastro', 'nao'), 'webhook', public.klingo_cfg('klingo_webhook', 'nao'), 'autogestao', public.klingo_cfg('klingo_autogestao', 'sim')),
    'operacoes', (select coalesce(jsonb_object_agg(estado, n), '{}'::jsonb) from (select estado, count(*) n from public.klingo_operacao where tipo = 'marcar'
                    and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by estado) x),
    'agendadas_sozinhas', (select count(*) from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id
                            where pa.agendado_origem = 'chat_api' and not c.teste and (pa.agendado_auto_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'resolvidas_sem_humano', (select count(*) from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id
                               where pa.agendado_origem = 'chat_api' and not c.teste and c.primeiro_humano_em is null and (pa.agendado_auto_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'tempo_medio_s', (select round(avg(extract(epoch from concluido_em - criado_em)))::int from public.klingo_operacao where tipo = 'marcar' and estado = 'sucesso' and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'motivos_falha', (select coalesce(jsonb_agg(jsonb_build_object('codigo', codigo, 'n', n) order by n desc), '[]'::jsonb) from (select coalesce(codigo, 'sem_codigo') codigo, count(*) n
                       from public.klingo_operacao where tipo = 'marcar' and estado in ('falha', 'incerto') and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by 1 order by 2 desc limit 8) x),
    'cadastros', (select coalesce(jsonb_object_agg(situacao, n), '{}'::jsonb) from (select situacao, count(*) n from public.klingo_identidade group by situacao) x),
    'convenios', jsonb_build_object('traduzidos', (select count(*) from public.klingo_plano_map where origem <> 'nao_atende'), 'sem_traducao', (select count(*) from public.klingo_plano_map where origem = 'nao_atende')),
    'horarios_api', jsonb_build_object('ok', public.klingo_medida_soma('horarios_api_ok', v_dias), 'erro', public.klingo_medida_soma('horarios_api_erro', v_dias), 'limite', public.klingo_medida_soma('horarios_api_limite', v_dias),
                      'api_total', public.klingo_medida_soma('sombra_api', v_dias), 'api_na_grade', public.klingo_medida_soma('sombra_api_na_grade', v_dias)),
    'decisoes', (select coalesce(jsonb_agg(jsonb_build_object('em', em, 'chave', chave, 'de', de, 'para', para) order by em desc), '[]'::jsonb) from (select * from public.klingo_decisao order by em desc limit 5) d),
    'gerado_em', now());
end $function$;

