-- Autoatendimento com a API do Klingo — Parte 7: indicadores (resolvido pela automação não é "sem atendimento humano") e o resumo do painel. Escrito em 12/11/2026.
--
-- FLUXOGRAMA: conversa resolvida pelo chat sozinho (pedido agendado com origem chat_api) deixa de contar em "sem atendimento humano" (ind_calc_semhumano) — senão cada marcação automática pareceria
--   abandono e o número "pioraria" quando a automação melhora. painel_automacao_resumo (só admin e atendente) devolve os números da automação sem nenhum dado de paciente:
--   modos ligados, operações por estado, conversas resolvidas sozinhas, tempo, motivos de falha, cadastros conferidos, convênios traduzidos e as últimas decisões da autogestão.
-- Versão 1.0 — 12/11/2026 / Mudança: primeira versão. Dias já fechados não mudam (ind_fechamento é imutável; antes de hoje nenhuma conversa tem origem chat_api).
-- Para voltar atrás: recolocar ind_calc_semhumano como está em supabase/producao/funcoes/ (git) e drop function public.painel_automacao_resumo(date, date).

create or replace function pg_temp.trocar(t text, velho text, novo text) returns text language plpgsql as $t$
begin
  if position(novo in t) > 0 then return t; end if;   -- já aplicado: a migração pode ser repetida sem estragar
  if (length(t) - length(replace(t, velho, ''))) / greatest(length(velho), 1) <> 1 then raise exception 'trecho nao encontrado exatamente uma vez: %', left(velho, 60); end if;
  return replace(t, velho, novo);
end $t$;
do $do$ declare d text;
begin
  d := pg_get_functiondef('public.ind_calc_semhumano(date, date)'::regprocedure);
  d := pg_temp.trocar(d, $a$   where (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
$a$, $a$   where (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
     and not exists (select 1 from public.pre_agendamentos pa where pa.conversa_id = c.id and pa.agendado_origem = 'chat_api')   -- klingo-auto: resolvida pela automação não é abandono
$a$);
  execute d;
end $do$;

create or replace function public.painel_automacao_resumo(p_de date default null, p_ate date default null) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
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
end $$;

revoke all on function public.painel_automacao_resumo(date, date) from public, anon;
grant execute on function public.painel_automacao_resumo(date, date) to authenticated, service_role;
