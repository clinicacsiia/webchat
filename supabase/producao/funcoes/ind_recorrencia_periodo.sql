-- public.ind_recorrencia_periodo(p_de date, p_ate date, p_un text, p_teste boolean, p_dias boolean)
-- Pode executar: service_role
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

