-- public.ind_agenda_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ind_agenda_periodo(p_de date, p_ate date, p_un text, p_teste boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v jsonb;
begin
  with
  ex as (
    select e.marcacao_id,
           (e.agendado_para at time zone 'America/Sao_Paulo')::date as dia,
           (e.agendado_em at time zone 'America/Sao_Paulo')::date as marcado,
           case when e.procedimento ~* '^consulta' then 'consulta' else 'exame' end as tipo,
           coalesce(public.unidade_chave(e.unidade), 'sem') as un,
           (coalesce(e.confirm_status, '') ilike 'confirmad%') as conf,
           (e.checkin_em is not null and (e.checkin_em at time zone 'America/Sao_Paulo')::date = (e.agendado_para at time zone 'America/Sao_Paulo')::date) as chegou,
           case e.status when 'remarcado' then 'remarcada' when 'cancelado' then 'cancelada' when 'atendido' then 'atendida' when 'faltou' then 'faltou'
                else case when (e.agendado_para at time zone 'America/Sao_Paulo')::date >= v_hoje then 'por_vir' else 'sem_fechamento' end end as r
      from public.jornada_exame e
      join public.klingo_conferencia kc on 'm' || kc.m = e.marcacao_id
      join public.conversas cw on cw.id = kc.conversa_id
     where e.status <> 'pedido'
       and (p_teste or not cw.teste)
       and (p_un is null or coalesce(public.unidade_chave(e.unidade), 'sem') = p_un)),
  base as (select * from ex where dia between p_de and p_ate),
  ag as (
    select g.grp, g.chave,
           count(*) as agendados,
           count(*) filter (where b.r = 'cancelada') as canceladas,
           count(*) filter (where b.r = 'remarcada') as remarcadas,
           count(*) filter (where b.r not in ('cancelada', 'remarcada')) as ficaram,
           count(*) filter (where b.r not in ('cancelada', 'remarcada') and b.conf) as confirmaram,
           count(*) filter (where b.r = 'atendida') as atendidas,
           count(*) filter (where b.r = 'faltou') as faltaram,
           count(*) filter (where b.r = 'por_vir') as por_vir,
           count(*) filter (where b.r = 'sem_fechamento') as sem_fechamento,
           count(*) filter (where b.r not in ('cancelada', 'remarcada') and b.chegou) as chegaram,
           count(*) filter (where b.r = 'atendida' and b.conf) as conf_atendidas,
           count(*) filter (where b.r = 'faltou' and b.conf) as conf_faltaram,
           count(*) filter (where b.r = 'atendida' and not b.conf) as nconf_atendidas,
           count(*) filter (where b.r = 'faltou' and not b.conf) as nconf_faltaram
      from base b cross join lateral (values ('total', 'todos'), ('tipo', b.tipo), ('un', b.un), ('dia', b.dia::text)) g(grp, chave)
     group by g.grp, g.chave),
  lin as (select grp, chave, to_jsonb(ag) - 'grp' - 'chave' as o from ag),
  hoje as (select count(*) filter (where r not in ('cancelada', 'remarcada')) as ficaram, count(*) filter (where r not in ('cancelada', 'remarcada') and conf) as confirmaram,
                  count(*) filter (where r not in ('cancelada', 'remarcada') and chegou) as chegaram, count(*) filter (where r = 'atendida') as atendidas,
                  count(*) filter (where r in ('cancelada', 'remarcada')) as saiu, count(*) as agendados
             from ex where dia = v_hoje),
  prox as (select dia, count(*) filter (where r not in ('cancelada', 'remarcada')) as ficaram, count(*) filter (where r not in ('cancelada', 'remarcada') and conf) as confirmaram
             from ex where dia > v_hoje and dia <= v_hoje + 3 group by dia),
  nov as (select count(*) as total, count(*) filter (where r = 'cancelada') as canceladas, count(*) filter (where r = 'remarcada') as remarcadas,
                 count(*) filter (where r not in ('cancelada', 'remarcada')) as ativas
            from ex where marcado between p_de and p_ate),
  pu as (select x.conversa_id, x.pessoa from public.painel_conversa_pessoa_un() x where p_un is null or (p_un = 'sem' and (x.chaves is null or cardinality(x.chaves) = 0)) or (p_un <> 'sem' and p_un = any (x.chaves))),
  site as (select count(distinct pu.pessoa) filter (where cardinality(coalesce(pa.klingo_marcacoes, '{}')) > 0) as com_marcacao,
                  count(distinct pu.pessoa) filter (where exists (select 1 from unnest(coalesce(pa.klingo_marcacoes, '{}')) u
                                                                    where exists (select 1 from public.klingo_conferencia z where z.m = u::text and z.status_klingo <> 'Cancelada'))) as com_marcacao_ativa
             from public.conversas c join pu on pu.conversa_id = c.id join public.pre_agendamentos pa on pa.conversa_id = c.id
            where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate),
  pes as (select pu.pessoa, bool_or(c.primeiro_humano_em is not null) as humano,
                 bool_or(c.motivo_encerramento = 'agendado' or exists (select 1 from public.pre_agendamentos pa where pa.conversa_id = c.id and pa.status = 'agendado')) as agendou
            from public.conversas c join pu on pu.conversa_id = c.id
           where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate group by pu.pessoa),
  pesa as (select count(*) as procuraram, count(*) filter (where humano) as atendidas, count(*) filter (where agendou) as agendaram, count(*) filter (where agendou and not humano) as sem_ajuda from pes),
  spd as (select (c.criado_em at time zone 'America/Sao_Paulo')::date as dia, count(distinct pu.pessoa) as pessoas,
                 count(distinct pu.pessoa) filter (where c.motivo_encerramento = 'agendado' or exists (select 1 from public.pre_agendamentos pa where pa.conversa_id = c.id and pa.status = 'agendado')) as agendaram
            from public.conversas c join pu on pu.conversa_id = c.id
           where (p_teste or not c.teste) and (c.criado_em at time zone 'America/Sao_Paulo')::date between p_de and p_ate group by 1)
  select jsonb_build_object(
    'total', coalesce((select o from lin where grp = 'total'), jsonb_build_object('agendados', 0, 'canceladas', 0, 'remarcadas', 0, 'ficaram', 0, 'confirmaram', 0, 'atendidas', 0, 'faltaram', 0, 'por_vir', 0, 'sem_fechamento', 0, 'chegaram', 0,
                                                                                    'conf_atendidas', 0, 'conf_faltaram', 0, 'nconf_atendidas', 0, 'nconf_faltaram', 0)),
    'por_tipo', coalesce((select jsonb_object_agg(chave, o) from lin where grp = 'tipo'), '{}'::jsonb),
    'por_unidade', coalesce((select jsonb_object_agg(chave, o) from lin where grp = 'un'), '{}'::jsonb),
    'por_dia', coalesce((select jsonb_agg(o || jsonb_build_object('dia', chave) order by chave) from lin where grp = 'dia'), '[]'::jsonb),
    'hoje', (select to_jsonb(hoje) from hoje),
    'proximos', coalesce((select jsonb_agg(jsonb_build_object('dia', dia, 'ficaram', ficaram, 'confirmaram', confirmaram) order by dia) from prox), '[]'::jsonb),
    'novas', (select to_jsonb(nov) from nov),
    'pessoas', (select to_jsonb(pesa) from pesa),
    'site', (select to_jsonb(site) from site),
    'site_por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia', dia, 'pessoas', pessoas, 'agendaram', agendaram) order by dia) from spd), '[]'::jsonb),
    'dados_desde', (select min((agendado_para at time zone 'America/Sao_Paulo')::date) from public.jornada_exame where status <> 'pedido'),
    'checkin_desde', (select min((checkin_em at time zone 'America/Sao_Paulo')::date) from public.jornada_exame where checkin_em is not null and (checkin_em at time zone 'America/Sao_Paulo')::date = (agendado_para at time zone 'America/Sao_Paulo')::date)
  ) into v;
  return v;
end $function$;

