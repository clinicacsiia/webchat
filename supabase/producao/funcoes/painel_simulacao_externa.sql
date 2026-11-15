-- public.painel_simulacao_externa(p_dias integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_simulacao_externa(p_dias integer DEFAULT 28)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tz text := 'America/Sao_Paulo';
  v_hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  v_dias integer := greatest(7, least(coalesce(p_dias, 28), 90));
  v_de timestamptz; v_hoje_ini timestamptz; v_amanha_ini timestamptz; v_fut timestamptz;
  v_base jsonb; v_chat jsonb; v_ped jsonb; v_conf jsonb; v_hoje_j jsonb; v_res jsonb;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem a simulação.' using errcode = '42501';
  end if;
  v_de := (v_hoje - v_dias)::timestamp at time zone v_tz;
  v_hoje_ini := v_hoje::timestamp at time zone v_tz;
  v_amanha_ini := (v_hoje + 1)::timestamp at time zone v_tz;
  v_fut := (v_hoje + 16)::timestamp at time zone v_tz;

  -- BASE: atendimentos antigos (dias fechados). media_dia = atendidos ÷ dias com algum atendimento.
  select jsonb_build_object(
    'de', v_hoje - v_dias, 'ate', v_hoje - 1,
    'dias_com_dado', coalesce(max(dias), 0), 'atendidos', coalesce(sum(n), 0),
    'media_dia', round(coalesce(sum(n), 0)::numeric / nullif(max(dias), 0), 1),
    'por_unidade', coalesce(jsonb_agg(jsonb_build_object('unidade', u, 'atendidos', n, 'media_dia', round(n::numeric / nullif(dias, 0), 1)) order by u) filter (where u is not null), '[]'::jsonb))
    into v_base
    from (select public.sim_unidade(e.unidade) as u, count(*) as n,
                 (select count(distinct (e2.agendado_para at time zone v_tz)::date) from public.jornada_exame e2
                   where e2.marcacao_id like 'm%' and e2.status = 'atendido' and e2.agendado_para >= v_de and e2.agendado_para < v_hoje_ini) as dias
            from public.jornada_exame e
           where e.marcacao_id like 'm%' and e.status = 'atendido' and e.agendado_para >= v_de and e.agendado_para < v_hoje_ini
           group by public.sim_unidade(e.unidade)) z;

  -- CHAT: pessoas esperando resposta da equipe e a média de conversas abertas por dia
  select jsonb_build_object(
    'esperando', count(*) filter (where status <> 'encerrada' and cliente_aguarda_desde is not null),
    'mais_antiga_min', coalesce(round(max(extract(epoch from (now() - cliente_aguarda_desde)) / 60) filter (where status <> 'encerrada' and cliente_aguarda_desde is not null))::int, 0),
    'abertas', count(*) filter (where status <> 'encerrada'),
    'conversas_dia', round(count(*) filter (where criado_em >= v_de and criado_em < v_hoje_ini)::numeric
                           / nullif((select count(distinct (c2.criado_em at time zone v_tz)::date) from public.conversas c2 where not c2.teste and c2.criado_em >= v_de and c2.criado_em < v_hoje_ini), 0), 1))
    into v_chat
    from public.conversas where not teste and (status <> 'encerrada' or criado_em >= v_de);

  -- PEDIDOS: pedido pronto que a recepção ainda não marcou
  select jsonb_build_object(
    'prontos', count(*) filter (where status = 'pronto'),
    'mais_antigo_h', coalesce(round(max(extract(epoch from (now() - atualizado_em)) / 3600) filter (where status = 'pronto'))::int, 0),
    'rascunhos', count(*) filter (where status = 'rascunho'),
    'agendados', count(*) filter (where status = 'agendado'))
    into v_ped
    from public.pre_agendamentos where criado_em >= v_de;

  -- CONFIRMAÇÃO: exames futuros por horizonte e situação (e por unidade)
  with fut as (
    select public.sim_unidade(e.unidade) as u, e.confirm_status as c,
           ((e.agendado_para at time zone v_tz)::date - v_hoje) as dias
      from public.jornada_exame e
     where e.marcacao_id like 'm%' and e.status in ('agendado', 'confirmado') and e.agendado_para >= v_hoje_ini and e.agendado_para < v_fut
       and public.sim_modalidade(e.procedimento) is not null
  ),
  h as (select u, c, case when dias <= 0 then 1 when dias = 1 then 2 when dias <= 3 then 3 when dias <= 7 then 4 else 5 end as o from fut)
  select coalesce(jsonb_agg(jsonb_build_object(
      'ordem', o, 'horizonte', case o when 1 then 'Hoje' when 2 then 'Amanhã' when 3 then 'Em 2 a 3 dias' when 4 then 'Em 4 a 7 dias' else 'Em 8 a 15 dias' end,
      'unidade', u, 'confirmado', conf, 'a_confirmar', ac, 'sem_resposta', sr, 'total', conf + ac + sr + outro) order by o, u), '[]'::jsonb)
    into v_conf
    from (select o, u,
                 count(*) filter (where c = 'Confirmado') as conf, count(*) filter (where c = 'A Confirmar') as ac,
                 count(*) filter (where c = 'Sem Resposta') as sr, count(*) filter (where c is null or c not in ('Confirmado', 'A Confirmar', 'Sem Resposta')) as outro
            from h where u is not null group by o, u) z;

  -- HOJE: a caminho, atrasados (sem chegada 30 min depois do horário), já atendidos, faltas
  with t as (
    select e.status, e.agendado_para, public.sim_unidade(e.unidade) as u
      from public.jornada_exame e
     where e.marcacao_id like 'm%' and e.agendado_para >= v_hoje_ini and e.agendado_para < v_amanha_ini
       and e.status in ('agendado', 'confirmado', 'atendido', 'faltou') and public.sim_modalidade(e.procedimento) is not null
  )
  select jsonb_build_object(
    'previstos', count(*), 'atendidos', count(*) filter (where status = 'atendido'), 'faltaram', count(*) filter (where status = 'faltou'),
    'a_caminho', count(*) filter (where status in ('agendado', 'confirmado') and agendado_para >= now() - interval '30 minutes'),
    'atrasados', count(*) filter (where status in ('agendado', 'confirmado') and agendado_para < now() - interval '30 minutes'),
    'por_unidade', coalesce((select jsonb_agg(jsonb_build_object('unidade', u, 'a_caminho', ac, 'atrasados', at) order by u)
                              from (select u, count(*) filter (where status in ('agendado', 'confirmado') and agendado_para >= now() - interval '30 minutes') as ac,
                                           count(*) filter (where status in ('agendado', 'confirmado') and agendado_para < now() - interval '30 minutes') as at
                                      from t where u is not null group by u) q), '[]'::jsonb))
    into v_hoje_j from t;

  -- RESULTADO: exames feitos nos últimos 14 dias por idade; entrega só existe se foi registrada
  select jsonb_build_object(
    'atendidos_14d', count(*),
    'faixas', jsonb_build_array(
       jsonb_build_object('faixa', '0 a 2 dias', 'n', count(*) filter (where dias <= 2)),
       jsonb_build_object('faixa', '3 a 7 dias', 'n', count(*) filter (where dias between 3 and 7)),
       jsonb_build_object('faixa', '8 a 14 dias', 'n', count(*) filter (where dias >= 8))),
    'entregues_registrados', (select count(*) from public.app_resultado where entregue_em is not null),
    'concluidos_jornada', (select count(*) from public.jornada_card where coluna = 'concluido' and data_ref >= v_hoje - 14))
    into v_res
    from (select (v_hoje - (e.agendado_para at time zone v_tz)::date) as dias
            from public.jornada_exame e
           where e.marcacao_id like 'm%' and e.status = 'atendido' and e.agendado_para >= ((v_hoje - 14)::timestamp at time zone v_tz) and e.agendado_para < v_amanha_ini) z;

  return jsonb_build_object('gerado_em', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'hoje', v_hoje,
                            'base', v_base, 'chat', v_chat, 'pedidos', v_ped, 'confirmacao', v_conf, 'dia_de_hoje', v_hoje_j, 'resultado', v_res);
end;
$function$;

