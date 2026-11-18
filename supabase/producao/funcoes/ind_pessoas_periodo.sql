-- public.ind_pessoas_periodo(p_de date, p_ate date, p_un text, p_teste boolean, p_tipo text)
-- Pode executar: service_role
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

