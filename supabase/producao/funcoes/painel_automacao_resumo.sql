-- public.painel_automacao_resumo(p_de date, p_ate date)
-- Pode executar: authenticated, service_role
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
    'modos', jsonb_build_object('horarios', public.klingo_cfg('klingo_api_horarios', 'nao'), 'marcar', public.klingo_cfg('klingo_api_marcar', 'nao'), 'percentual', public.klingo_cfg('klingo_api_percentual', '100'),
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

