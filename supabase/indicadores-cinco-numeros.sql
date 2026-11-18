-- FLUXOGRAMA: entrada (pedido do dono, 18/11/2026: topo da aba Indicadores com 5 números, todos na mesma base = PESSOAS pelo dia em que abriram o chat) -> validação (painel_indicadores_pessoas só para admin e atendente; ind_pessoas_periodo só para o servidor; tipo só 'exame' ou 'consulta', outro valor = todos) -> lógica (1. procuraram = pessoas que abriram o chat no período; 2. atendidos = dessas, as que um atendente assumiu ou respondeu; 3. agendaram = dessas, as que têm marcação CONFIRMADA no Klingo (pre_agendamentos.klingo_marcacoes preenchido); 4. robô sozinho = das que agendaram, as que o sistema marcou pela API (agendado_origem = 'chat_api'), com a contagem das que nem tiveram atendente na conversa; 5. faltaram ou cancelaram = das que agendaram, as com marcação faltada ou cancelada no Klingo (remarcada NÃO conta: trocar de data não é perda)) -> saída (jsonb com atual e anterior, mesmo formato das outras painel_indicadores_*)
-- Versão 1.0 — 18/11/2026 / Mudança: Implementação inicial. Só funções NOVAS (nenhuma existente é alterada): ind_pessoas_periodo e painel_indicadores_pessoas.
-- Filtro de tipo (p_tipo): 'exame' ou 'consulta' olha o tipo do PEDIDO do chat (pre_agendamentos.tipo). Com filtro, "procuraram" = pessoas que começaram um pedido daquele tipo.
-- Limite conhecido: "faltaram" só existe para marcação cuja data já passou e que o Klingo fechou; marcação futura ainda pode faltar. A tela avisa.
-- ROLLBACK: drop function public.painel_indicadores_pessoas(date, date, text, boolean, text); drop function public.ind_pessoas_periodo(date, date, text, boolean, text);
-- APLICAR EM PARTES (a ferramenta de migração expira em 60 s): parte 1 = ind_pessoas_periodo (+ permissões), parte 2 = painel_indicadores_pessoas (+ permissões). O painel novo funciona com a tela antiga em cache: nada existente muda.

-- Parte 1: ind_pessoas_periodo
CREATE OR REPLACE FUNCTION public.ind_pessoas_periodo(p_de date, p_ate date, p_un text, p_teste boolean, p_tipo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tipo text := case when lower(coalesce(p_tipo, '')) in ('exame', 'consulta') then lower(p_tipo) end;
  v jsonb;
begin
  with
  pu as (select x.conversa_id, x.pessoa from public.painel_conversa_pessoa_un() x
          where p_un is null or (p_un = 'sem' and (x.chaves is null or cardinality(x.chaves) = 0)) or (p_un <> 'sem' and p_un = any (x.chaves))),
  cv as (select c.id, pu.pessoa, c.primeiro_humano_em
           from public.conversas c join pu on pu.conversa_id = c.id
          where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
  pd as (select cv.pessoa, cv.primeiro_humano_em, pa.tipo, pa.agendado_origem,
                (cardinality(coalesce(pa.klingo_marcacoes, '{}')) > 0) as tem_marcacao,
                exists (select 1 from unnest(coalesce(pa.klingo_marcacoes, '{}')) u join public.jornada_exame je on je.marcacao_id = 'm' || u where je.status = 'faltou') as faltou,
                exists (select 1 from unnest(coalesce(pa.klingo_marcacoes, '{}')) u join public.jornada_exame je on je.marcacao_id = 'm' || u where je.status = 'cancelado') as cancelou
           from cv join public.pre_agendamentos pa on pa.conversa_id = cv.id
          where v_tipo is null or pa.tipo = v_tipo),
  base as (select distinct cv.pessoa from cv
            where v_tipo is null or exists (select 1 from pd where pd.pessoa = cv.pessoa)),
  hum as (select cv.pessoa, bool_or(cv.primeiro_humano_em is not null) as humano from cv group by cv.pessoa),
  mk as (select pd.pessoa,
                bool_or(pd.tem_marcacao) as agendou,
                bool_or(pd.tem_marcacao and pd.agendado_origem = 'chat_api') as robo,
                bool_or(pd.tem_marcacao and pd.agendado_origem = 'chat_api' and pd.primeiro_humano_em is null) as robo_sem_atendente,
                bool_or(pd.tem_marcacao and pd.faltou) as faltou,
                bool_or(pd.tem_marcacao and pd.cancelou) as cancelou
           from pd group by pd.pessoa)
  select jsonb_build_object(
    'procuraram', (select count(*) from base),
    'atendidos', (select count(*) from base b join hum on hum.pessoa = b.pessoa where hum.humano),
    'agendaram', (select count(*) from base b join mk on mk.pessoa = b.pessoa where mk.agendou),
    'robo', (select count(*) from base b join mk on mk.pessoa = b.pessoa where mk.agendou and mk.robo),
    'robo_sem_atendente', (select count(*) from base b join mk on mk.pessoa = b.pessoa where mk.agendou and mk.robo_sem_atendente),
    'faltaram', (select count(*) from base b join mk on mk.pessoa = b.pessoa where mk.agendou and mk.faltou),
    'cancelaram', (select count(*) from base b join mk on mk.pessoa = b.pessoa where mk.agendou and mk.cancelou),
    'faltaram_ou_cancelaram', (select count(*) from base b join mk on mk.pessoa = b.pessoa where mk.agendou and (mk.faltou or mk.cancelou))
  ) into v;
  return v;
end $function$;
REVOKE ALL ON FUNCTION public.ind_pessoas_periodo(date, date, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ind_pessoas_periodo(date, date, text, boolean, text) TO service_role;

-- Parte 2: painel_indicadores_pessoas
CREATE OR REPLACE FUNCTION public.painel_indicadores_pessoas(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false, p_tipo text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_len integer;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
  v_tipo text := case when lower(coalesce(p_tipo, '')) in ('exame', 'consulta') then lower(p_tipo) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  v_len := v_ate - v_de + 1;
  return jsonb_build_object('periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'anterior_periodo', jsonb_build_object('de', v_de - v_len, 'ate', v_de - 1),
    'unidade', v_un, 'tipo', v_tipo, 'gerado_em', now(),
    'atual', public.ind_pessoas_periodo(v_de, v_ate, v_un, coalesce(p_incluir_teste, false), v_tipo),
    'anterior', public.ind_pessoas_periodo(v_de - v_len, v_de - 1, v_un, coalesce(p_incluir_teste, false), v_tipo));
end $function$;
REVOKE ALL ON FUNCTION public.painel_indicadores_pessoas(date, date, text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.painel_indicadores_pessoas(date, date, text, boolean, text) TO authenticated, service_role;
