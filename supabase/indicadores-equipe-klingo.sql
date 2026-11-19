-- FLUXOGRAMA: entrada (pedido do dono, 19/11/2026: no topo da aba Indicadores, quanto a equipe da unidade cadastrou no Klingo e quantas conversas a equipe encerrou como "Agendado") -> validação (painel_indicadores_equipe_klingo só para admin e atendente; ind_equipe_klingo_periodo só para o servidor; unidade só csi, rmtc ou desenvoar, outro valor = todas; conversa de teste fica fora, salvo o administrador pedir) -> lógica (BLOCO 1, KLINGO: marcações do Klingo (klingo_conferencia, vinda do relatório #14554) pelo dia em que foram MARCADAS, de qualquer canal (WhatsApp, telefone, recepção, sem origem); "robô" = marcada pela API (via_api); "equipe" = todas as outras; canceladas à parte; por origem (só as da equipe). BLOCO 2, ENCERRADAS: conversas com motivo_encerramento = 'agendado', pelo dia em que foram ENCERRADAS, da unidade responsável (ou da inicial); dessas, quantas têm marcação no Klingo (klingo_conferencia.conversa_id), se a marcação foi da equipe ou do robô, e quantas NÃO têm marcação encontrada) -> saída (jsonb com atual e anterior, mesmo formato das outras painel_indicadores_*)
-- Versão 1.0 — 19/11/2026 / Mudança: Implementação inicial. Só funções NOVAS (nenhuma existente é alterada): ind_equipe_klingo_periodo e painel_indicadores_equipe_klingo.
-- Diferença para os "5 números do topo": aqueles contam PESSOAS pelo dia em que abriram o chat; aqui a conta é por MARCAÇÃO (bloco 1, pelo dia da marcação) e por CONVERSA (bloco 2, pelo dia do encerramento). Os totais não precisam bater entre si.
-- Limites conhecidos: (1) o Klingo não diz QUEM marcou, só o canal (origem) e se foi pela API; "equipe" aqui significa "não foi o robô". (2) klingo_conferencia não guarda o procedimento, então estes números NÃO separam consulta e exame: a tela avisa quando o filtro de tipo está ligado. (3) conta marcações, não pessoas: quem marcou dois exames conta duas vezes.
-- DEPENDÊNCIA: a coluna klingo_conferencia.via_api (true = o responsável da marcação no Klingo é a API do chat, `biclinicacsi`; só sim/não). Ela já está na produção (migrações klingo_via_api_parte1..3, arquivos supabase/klingo-via-api-parte1..3.sql do PR 239, ainda não unido à main); sem ela a função falha.
-- ROLLBACK: drop function public.painel_indicadores_equipe_klingo(date, date, text, boolean); drop function public.ind_equipe_klingo_periodo(date, date, text, boolean);
-- APLICAR EM PARTES (a ferramenta de migração expira em 60 s): parte 1 = ind_equipe_klingo_periodo (+ permissões), parte 2 = painel_indicadores_equipe_klingo (+ permissões). O painel novo funciona com a tela antiga em cache: nada existente muda.

-- Parte 1: ind_equipe_klingo_periodo
CREATE OR REPLACE FUNCTION public.ind_equipe_klingo_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v jsonb;
begin
  with
  kc as (
    select coalesce(k.via_api, false) as robo,
           (k.status_klingo = 'Cancelada') as cancelada,
           coalesce(nullif(btrim(k.origem), ''), 'sem_origem') as origem
      from public.klingo_conferencia k
      left join public.conversas c on c.id = k.conversa_id
     where k.marcado_em between p_de and p_ate
       and (p_un is null or coalesce(public.unidade_chave(k.unidade), 'sem') = p_un)
       and (p_teste or c.teste is not true)),
  cv as (
    select c.id,
           (select count(*) from public.klingo_conferencia k where k.conversa_id = c.id) as n_marc,
           coalesce((select bool_or(coalesce(k.via_api, false)) from public.klingo_conferencia k where k.conversa_id = c.id), false) as robo
      from public.conversas c
     where c.motivo_encerramento = 'agendado'
       and (c.encerrada_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
       and (p_teste or not c.teste)
       and (p_un is null or coalesce(c.unidade_responsavel, c.unidade_inicial, 'sem') = p_un))
  select jsonb_build_object(
    'klingo', jsonb_build_object(
      'total', (select count(*) from kc),
      'robo', (select count(*) from kc where robo),
      'equipe', (select count(*) from kc where not robo),
      'canceladas', (select count(*) from kc where cancelada),
      'por_origem', coalesce((select jsonb_object_agg(o.origem, o.n) from (select origem, count(*) as n from kc where not robo group by origem) o), '{}'::jsonb)),
    'encerradas', jsonb_build_object(
      'agendado', (select count(*) from cv),
      'com_marcacao', (select count(*) from cv where n_marc > 0),
      'equipe', (select count(*) from cv where n_marc > 0 and not robo),
      'robo', (select count(*) from cv where n_marc > 0 and robo),
      'sem_marcacao', (select count(*) from cv where n_marc = 0))
  ) into v;
  return v;
end $function$;
REVOKE ALL ON FUNCTION public.ind_equipe_klingo_periodo(date, date, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ind_equipe_klingo_periodo(date, date, text, boolean) TO service_role;

-- Parte 2: painel_indicadores_equipe_klingo
CREATE OR REPLACE FUNCTION public.painel_indicadores_equipe_klingo(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_len integer;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ate := least(coalesce(p_ate, v_hoje), v_hoje);
  v_de := greatest(coalesce(p_de, v_ate - 6), v_ate - 400);
  if v_de > v_ate then v_de := v_ate; end if;
  v_len := v_ate - v_de + 1;
  return jsonb_build_object('periodo', jsonb_build_object('de', v_de, 'ate', v_ate), 'anterior_periodo', jsonb_build_object('de', v_de - v_len, 'ate', v_de - 1),
    'unidade', v_un, 'gerado_em', now(),
    'atual', public.ind_equipe_klingo_periodo(v_de, v_ate, v_un, coalesce(p_incluir_teste, false)),
    'anterior', public.ind_equipe_klingo_periodo(v_de - v_len, v_de - 1, v_un, coalesce(p_incluir_teste, false)));
end $function$;
REVOKE ALL ON FUNCTION public.painel_indicadores_equipe_klingo(date, date, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.painel_indicadores_equipe_klingo(date, date, text, boolean) TO authenticated, service_role;
