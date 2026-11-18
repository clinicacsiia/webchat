-- FLUXOGRAMA: entrada (13 chaves do autoatendimento do Klingo que ficaram sem efeito em 14/11/2026, quando o autoatendimento passou a ser SEMPRE LIGADO) -> validação (klingo_modo devolve 'sim' para qualquer conversa e ignora o valor guardado; só klingo_api_resultado ainda segue a configuração e por isso NÃO é apagada)
--   -> lógica (1º painel_automacao_resumo deixa de ler as chaves e devolve os mesmos campos com o valor fixo "sim"; 2º apaga as 13 linhas) -> saída (a tela Indicadores segue igual: ela nem lê o bloco "modos"; as Configurações não mostram mais essas chaves)
-- Versão 1.0 — 18/11/2026 / Mudança: Implementação inicial. Pedido do dono: apagar o que não é usado nas Configurações.
-- Chaves apagadas: klingo_auto, klingo_api_horarios, klingo_api_marcar, klingo_api_pre_cadastro, klingo_api_consultar, klingo_api_cancelar, klingo_api_remarcar, klingo_api_pos, klingo_api_percentual, klingo_autogestao, previsao_modo, previsao_monitor_modo, notificacao_modo.
-- Funções que ainda citam essas chaves (klingo_ativo, klingo_chave_de_modo, klingo_modo_chave, klingo_agendamento_passar etc.) continuam iguais: passam o nome da chave para klingo_modo, que o ignora; klingo_agendamento_passar lê klingo_auto com padrão 'sim' e não usa o valor.
-- Continuam valendo e NÃO são apagadas: klingo_api_resultado, klingo_api_telefones_teste, pedido_horario_modo, klingo_webhook, permissao_modo.
-- Aplicar em duas chamadas pequenas (a ferramenta expira em 60 s): primeiro o create or replace, depois o delete.
-- ROLLBACK: supabase/limpeza-config-rollback.sql (recria as 13 chaves com o valor que tinham e a função como era).

-- ===== chamada 1 de 2 =====
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
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje); v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400); if v_de > v_ate then v_de := v_ate; end if; v_dias := greatest(v_ate - v_de + 1, 1);
  return jsonb_build_object(
    'modos', jsonb_build_object('mestre', 'sim', 'horarios', 'sim', 'marcar', 'sim', 'pre_cadastro', 'sim', 'webhook', public.klingo_cfg('klingo_webhook', 'nao')),
    'operacoes', (select coalesce(jsonb_object_agg(estado, n), '{}'::jsonb) from (select estado, count(*) n from public.klingo_operacao where (conversa_id is null or conversa_id not in (select id from public.conversas where teste)) and tipo = 'marcar'
                    and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by estado) x),
    'agendadas_sozinhas', (select count(*) from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id
                            where pa.agendado_origem = 'chat_api' and not c.teste and (pa.agendado_auto_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'resolvidas_sem_humano', (select count(*) from public.pre_agendamentos pa join public.conversas c on c.id = pa.conversa_id
                               where pa.agendado_origem = 'chat_api' and not c.teste and c.primeiro_humano_em is null and (pa.agendado_auto_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'marcar_canceladas_no_klingo', (select count(*) from public.klingo_operacao o join public.klingo_conferencia k on k.m = o.voucher_id
                                     where (o.conversa_id is null or o.conversa_id not in (select id from public.conversas where teste)) and o.tipo = 'marcar' and o.estado = 'sucesso' and k.status_klingo = 'Cancelada' and (o.criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'tempo_medio_s', (select round(avg(extract(epoch from concluido_em - criado_em)))::int from public.klingo_operacao where (conversa_id is null or conversa_id not in (select id from public.conversas where teste)) and tipo = 'marcar' and estado = 'sucesso' and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate),
    'motivos_falha', (select coalesce(jsonb_agg(jsonb_build_object('codigo', codigo, 'n', n) order by n desc), '[]'::jsonb) from (select coalesce(codigo, 'sem_codigo') codigo, count(*) n
                       from public.klingo_operacao where (conversa_id is null or conversa_id not in (select id from public.conversas where teste)) and tipo = 'marcar' and estado in ('falha', 'incerto') and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by 1 order by 2 desc limit 8) x),
    'pos', (select coalesce(jsonb_object_agg(k, n), '{}'::jsonb) from (select tipo || ':' || estado k, count(*) n from public.klingo_operacao where (conversa_id is null or conversa_id not in (select id from public.conversas where teste)) and tipo in ('cancelar', 'remarcar', 'ler_vouchers') and (criado_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by 1) x),
    'cadastros', (select coalesce(jsonb_object_agg(situacao, n), '{}'::jsonb) from (select situacao, count(*) n from public.klingo_identidade where (conferido_em at time zone 'America/Sao_Paulo')::date between v_de and v_ate group by situacao) x),
    'convenios', jsonb_build_object('traduzidos', (select count(*) from public.klingo_plano_map where origem <> 'nao_atende'), 'sem_traducao', (select count(*) from public.klingo_plano_map where origem = 'nao_atende')),
    'horarios_api', jsonb_build_object('ok', public.klingo_medida_soma('horarios_api_ok', v_dias), 'erro', public.klingo_medida_soma('horarios_api_erro', v_dias), 'limite', public.klingo_medida_soma('horarios_api_limite', v_dias),
                      'api_total', public.klingo_medida_soma('sombra_api', v_dias), 'api_na_grade', public.klingo_medida_soma('sombra_api_na_grade', v_dias)),
    'decisoes', (select coalesce(jsonb_agg(jsonb_build_object('em', em, 'chave', chave, 'de', de, 'para', para) order by em desc), '[]'::jsonb) from (select * from public.klingo_decisao order by em desc limit 5) d),
    'gerado_em', now());
end $function$;

-- ===== chamada 2 de 2 =====
delete from public.config
 where chave in ('klingo_auto', 'klingo_api_horarios', 'klingo_api_marcar', 'klingo_api_pre_cadastro', 'klingo_api_consultar', 'klingo_api_cancelar', 'klingo_api_remarcar',
                 'klingo_api_pos', 'klingo_api_percentual', 'klingo_autogestao', 'previsao_modo', 'previsao_monitor_modo', 'notificacao_modo');
