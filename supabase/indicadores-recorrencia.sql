-- FLUXOGRAMA: entrada (pedido do dono, 19/11/2026: um indicador de RECORRÊNCIA: quantas pessoas estão usando, quem é primeira vez e quantas pessoas já estão cadastradas) -> validação (painel_indicadores_recorrencia só para admin e atendente; ind_recorrencia_periodo só para o servidor) -> lógica (pessoa = conversas da mesma pessoa juntas, como no resto dos indicadores; "primeira vez" = a primeira conversa da pessoa em toda a história caiu dentro do período; "recorrente" = já tinha conversa ANTES do período e voltou a abrir uma dentro dele; "cadastradas" = pessoas distintas que já abriram o chat até o fim do período; acesso rápido = contas do app com PIN) -> saída (JSON só com números: nenhum nome, telefone ou CPF sai).
-- Versão 1.0 — 19/11/2026 / Mudança: Implementação inicial. Só funções NOVAS (nenhuma existente é alterada): ind_recorrencia_base, ind_recorrencia_periodo e painel_indicadores_recorrencia.
-- Regras:
--   * PESSOA aqui = o MESMO CELULAR (contato) ou o agrupamento de pessoa única (conversa_grupo), o que juntar mais. Não é a mesma conta dos 5 números do topo (que só usam o agrupamento): na produção, 30 dos 75 celulares com mais de uma conversa estavam em "pessoas" separadas porque o agrupamento automático exige 3 dados batendo. Para medir quem VOLTOU, o celular repetido tem de contar como a mesma pessoa. Limite: se um celular tiver dois agrupamentos diferentes, as conversas sem agrupamento seguem o de menor código.
--   * Dia = dia de calendário em São Paulo (igual aos outros indicadores). Conversas de teste ficam fora (só entram com p_incluir_teste).
--   * Filtro de unidade (p_unidade) vale para o bloco do chat (mesma regra de unidade da pessoa de painel_conversa_pessoa_un). "Primeira vez" olha a história inteira da pessoa, não só a unidade: quem já falou em outra unidade antes não é primeira vez.
--   * Acesso rápido (app_paciente) é da clínica toda: não tem unidade nem marca de teste.
--   * Limite conhecido: o acesso rápido guarda só o ÚLTIMO acesso de cada conta (ultimo_acesso_em). "Usaram no período" = contas cujo último acesso caiu no período; para um período antigo isso fica abaixo do real. O chat não tem esse limite (cada conversa tem a sua data).
--   * Limite conhecido: o sistema só tem dados desde 29/10/2026; "primeira vez" de quem falava antes dessa data aparece como primeira vez.
-- ROLLBACK: drop function public.painel_indicadores_recorrencia(date, date, text, boolean); drop function public.ind_recorrencia_periodo(date, date, text, boolean, boolean); drop function public.ind_recorrencia_base(date, boolean);
-- APLICAR EM PARTES (a ferramenta de migração expira em 60 s): parte 1 = ind_recorrencia_base, parte 2 = ind_recorrencia_periodo, parte 3 = painel_indicadores_recorrencia (cada uma com as permissões). A tela antiga continua funcionando: nada existente muda.

-- Parte 1: ind_recorrencia_base (uma linha por conversa: de que pessoa é, em que dia abriu e em que unidades)
CREATE OR REPLACE FUNCTION public.ind_recorrencia_base(p_ate date, p_teste boolean)
 RETURNS TABLE(pessoa text, dia date, chaves text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with c0 as (
    select c.contato_id, cg.grupo_id, (c.criado_em at time zone 'America/Sao_Paulo')::date as dia, x.chaves
      from public.conversas c
      join public.painel_conversa_pessoa_un() x on x.conversa_id = c.id
      left join public.conversa_grupo cg on cg.conversa_id = c.id
     where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date <= p_ate),
  rep as (select c0.contato_id, min(c0.grupo_id::text) as g from c0 where c0.grupo_id is not null group by c0.contato_id)
  select coalesce(c0.grupo_id::text, rep.g, 'c' || c0.contato_id::text), c0.dia, c0.chaves
    from c0 left join rep on rep.contato_id = c0.contato_id
$function$;
REVOKE ALL ON FUNCTION public.ind_recorrencia_base(date, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ind_recorrencia_base(date, boolean) TO service_role;

-- Parte 2: ind_recorrencia_periodo
CREATE OR REPLACE FUNCTION public.ind_recorrencia_periodo(p_de date, p_ate date, p_un text, p_teste boolean, p_dias boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_chat jsonb; v_app jsonb; v_dia jsonb := '[]'::jsonb;
begin
  with
  -- toda conversa (não teste) com a pessoa dela; a unidade só entra no recorte dos números, nunca na história da pessoa
  cv as (select b.pessoa, b.dia, b.chaves from public.ind_recorrencia_base(p_ate, p_teste) b),
  un as (select distinct cv.pessoa from cv
          where p_un is null or (p_un = 'sem' and (cv.chaves is null or cardinality(cv.chaves) = 0)) or (p_un <> 'sem' and p_un = any (cv.chaves))),
  pe as (select cv.pessoa, min(cv.dia) as primeira, count(*) as conversas,
                count(*) filter (where cv.dia between p_de and p_ate) as no_periodo
           from cv where cv.pessoa in (select un.pessoa from un) group by cv.pessoa),
  ativ as (select pe.* from pe where pe.no_periodo > 0)
  select jsonb_build_object(
    'cadastradas', (select count(*) from pe),
    'cadastradas_antes', (select count(*) from pe where pe.primeira < p_de),
    'usaram', (select count(*) from ativ),
    'primeira_vez', (select count(*) from ativ where ativ.primeira >= p_de),
    'recorrentes', (select count(*) from ativ where ativ.primeira < p_de),
    'primeira_vez_voltaram', (select count(*) from ativ where ativ.primeira >= p_de and ativ.no_periodo > 1),
    'conversas_no_periodo', (select coalesce(sum(ativ.no_periodo), 0) from ativ),
    'historico_1', (select count(*) from pe where pe.conversas = 1),
    'historico_2', (select count(*) from pe where pe.conversas = 2),
    'historico_3mais', (select count(*) from pe where pe.conversas >= 3)
  ) into v_chat;

  select jsonb_build_object(
    'total', count(*) filter (where (a.criado_em at time zone 'America/Sao_Paulo')::date <= p_ate),
    'novas', count(*) filter (where (a.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
    'usaram', count(*) filter (where (a.ultimo_acesso_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
    'voltaram', count(*) filter (where (a.ultimo_acesso_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate
                                   and (a.criado_em at time zone 'America/Sao_Paulo')::date < p_de),
    'voltaram_outro_dia', count(*) filter (where (a.criado_em at time zone 'America/Sao_Paulo')::date <= p_ate
                                   and (a.ultimo_acesso_em at time zone 'America/Sao_Paulo')::date > (a.criado_em at time zone 'America/Sao_Paulo')::date
                                   and (a.ultimo_acesso_em at time zone 'America/Sao_Paulo')::date <= p_ate),
    'so_no_dia_do_cadastro', count(*) filter (where (a.criado_em at time zone 'America/Sao_Paulo')::date <= p_ate
                                   and (a.ultimo_acesso_em is null
                                        or (a.ultimo_acesso_em at time zone 'America/Sao_Paulo')::date = (a.criado_em at time zone 'America/Sao_Paulo')::date))
  ) into v_app
  from public.app_paciente a;

  if p_dias then
    -- um dia por linha: quem abriu o chat naquele dia, quantos eram primeira vez e quantos já tinham falado antes
    with
    cv as (select b.pessoa, b.dia, b.chaves from public.ind_recorrencia_base(p_ate, p_teste) b),
    un as (select distinct cv.pessoa from cv
            where p_un is null or (p_un = 'sem' and (cv.chaves is null or cardinality(cv.chaves) = 0)) or (p_un <> 'sem' and p_un = any (cv.chaves))),
    pr as (select cv.pessoa, min(cv.dia) as primeira from cv where cv.pessoa in (select un.pessoa from un) group by cv.pessoa),
    pd as (select distinct cv.pessoa, cv.dia from cv where cv.dia >= p_de and cv.pessoa in (select un.pessoa from un))
    select coalesce(jsonb_agg(jsonb_build_object('dia', d.dia, 'pessoas', d.pessoas, 'primeira_vez', d.nova, 'recorrentes', d.pessoas - d.nova) order by d.dia), '[]'::jsonb)
      into v_dia
      from (select pd.dia, count(*) as pessoas, count(*) filter (where pr.primeira = pd.dia) as nova
              from pd join pr on pr.pessoa = pd.pessoa group by pd.dia) d;
  end if;

  return jsonb_build_object('chat', v_chat, 'acesso_rapido', v_app, 'por_dia', v_dia);
end $function$;
REVOKE ALL ON FUNCTION public.ind_recorrencia_periodo(date, date, text, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ind_recorrencia_periodo(date, date, text, boolean, boolean) TO service_role;

-- Parte 3: painel_indicadores_recorrencia
CREATE OR REPLACE FUNCTION public.painel_indicadores_recorrencia(p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_incluir_teste boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_ate date; v_de date; v_len integer;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar', 'sem') then lower(p_unidade) end;
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
    'atual', public.ind_recorrencia_periodo(v_de, v_ate, v_un, coalesce(p_incluir_teste, false), true),
    'anterior', public.ind_recorrencia_periodo(v_de - v_len, v_de - 1, v_un, coalesce(p_incluir_teste, false), false));
end $function$;
REVOKE ALL ON FUNCTION public.painel_indicadores_recorrencia(date, date, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.painel_indicadores_recorrencia(date, date, text, boolean) TO authenticated, service_role;
