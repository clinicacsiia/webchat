-- public.ia_relatorio(p_dias integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.ia_relatorio(p_dias integer DEFAULT 28)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_dias int := least(greatest(coalesce(p_dias, 28), 7), 365);
  v_ini timestamptz := now() - make_interval(days => v_dias);
  v_ids uuid[];
  v_desde timestamptz := (select min(e.criado_em) from public.ia_evento e);
  v_sem_registro int;
  v_resumo jsonb; v_alertas jsonb; v_abandono jsonb; v_semanas jsonb; v_exames jsonb; v_atend jsonb; v_conv jsonb; v_tempo numeric;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then
    raise exception 'Somente o administrador vê o relatório de aprendizado.' using errcode = '42501';
  end if;

  v_ids := array(select c.id from public.ia_coorte(v_ini) c);

  select jsonb_build_object(
    'criados', count(*),
    'agendados_auto', count(*) filter (where p.status = 'agendado' and u.detalhe = 'automatico'),
    'agendados_auto_sem_alerta', count(*) filter (where p.status = 'agendado' and u.detalhe = 'automatico'
        and not exists (select 1 from public.ia_evento e where e.pre_agendamento_id = p.id and e.tipo = 'conferencia' and e.para <> 'confirmado')),
    'agendados_manual', count(*) filter (where p.status = 'agendado' and u.detalhe is distinct from 'automatico'),
    'cancelados', count(*) filter (where p.status = 'cancelado'),
    'prontos_esperando', count(*) filter (where p.status = 'pronto'),
    'em_andamento', count(*) filter (where p.status = 'rascunho' and p.atualizado_em >= now() - interval '24 hours'),
    'abandonados', count(*) filter (where p.status = 'rascunho' and p.atualizado_em < now() - interval '24 hours'),
    'com_alerta_agora', count(*) filter (where p.conferencia_status is not null and p.conferencia_status <> 'confirmado'))
    into v_resumo
    from public.pre_agendamentos p
    left join lateral (select e2.detalhe from public.ia_evento e2
                        where e2.pre_agendamento_id = p.id and e2.tipo = 'status' and e2.para = 'agendado' order by e2.criado_em desc limit 1) u on true
    where p.id = any(v_ids);

  select coalesce(jsonb_object_agg(x.para, x.n), '{}'::jsonb) into v_alertas
    from (select e.para, count(distinct e.pre_agendamento_id) as n from public.ia_evento e
           where e.tipo = 'conferencia' and e.para <> 'confirmado' and e.pre_agendamento_id = any(v_ids)
           group by e.para) x;

  select coalesce(jsonb_object_agg(x.etapa, x.n), '{}'::jsonb) into v_abandono
    from (select coalesce(p.etapa, 'pedido') as etapa, count(*) as n from public.pre_agendamentos p
           where p.status = 'rascunho' and p.atualizado_em < now() - interval '24 hours' and p.id = any(v_ids) group by 1) x;

  select round((percentile_cont(0.5) within group (order by x.minutos))::numeric, 1) into v_tempo
    from (select (extract(epoch from (a.t - p.t)) / 60)::double precision as minutos
            from (select e.pre_agendamento_id, min(e.criado_em) as t from public.ia_evento e
                   where e.tipo = 'status' and e.para = 'pronto' and e.pre_agendamento_id = any(v_ids)
                   group by e.pre_agendamento_id) p
            cross join lateral (select min(e2.criado_em) as t from public.ia_evento e2
                                 where e2.pre_agendamento_id = p.pre_agendamento_id and e2.tipo = 'status' and e2.para = 'agendado' and e2.criado_em >= p.t) a
           where a.t is not null) x;

  select coalesce(jsonb_agg(jsonb_build_object('semana', s.semana, 'criados', s.criados, 'agendados', s.agendados, 'com_alerta', s.com_alerta, 'cancelados', s.cancelados) order by s.semana), '[]'::jsonb)
    into v_semanas
    from (select date_trunc('week', p.criado_em at time zone 'America/Bahia')::date as semana,
                 count(*) as criados,
                 count(*) filter (where p.status = 'agendado') as agendados,
                 count(*) filter (where exists (select 1 from public.ia_evento e where e.pre_agendamento_id = p.id and e.tipo = 'conferencia' and e.para <> 'confirmado')) as com_alerta,
                 count(*) filter (where p.status = 'cancelado') as cancelados
            from public.pre_agendamentos p where p.id = any(v_ids) group by 1) s;

  select coalesce(jsonb_agg(jsonb_build_object('exame', y.exame, 'problemas', y.problemas, 'total', y.total) order by y.problemas desc, y.exame), '[]'::jsonb) into v_exames
    from (select x.exame,
                 count(distinct e.pre_agendamento_id) filter (where (e.tipo = 'conferencia' and e.para <> 'confirmado') or (e.tipo = 'status' and e.para = 'cancelado')) as problemas,
                 count(distinct e.pre_agendamento_id) as total
            from public.ia_evento e
            cross join lateral jsonb_array_elements_text(coalesce(e.contexto -> 'exames', '[]'::jsonb)) x(exame)
           where e.pre_agendamento_id = any(v_ids)
           group by x.exame
          having count(distinct e.pre_agendamento_id) filter (where (e.tipo = 'conferencia' and e.para <> 'confirmado') or (e.tipo = 'status' and e.para = 'cancelado')) > 0
           order by 2 desc, 1 limit 10) y;

  select jsonb_build_object(
    'marcou_agendado', count(*) filter (where e.tipo = 'status' and e.para = 'agendado' and e.por = 'atendente'),
    'cancelou', count(*) filter (where e.tipo = 'status' and e.para = 'cancelado' and e.por = 'atendente'),
    'desfez_agendado', count(*) filter (where e.tipo = 'status' and e.de = 'agendado' and e.para in ('pronto', 'rascunho') and e.por = 'atendente'),
    'cancelou_com_motivo', count(*) filter (where e.tipo = 'status' and e.para = 'cancelado' and e.por = 'atendente' and e.detalhe is not null))
    into v_atend from public.ia_evento e where e.pre_agendamento_id = any(v_ids);

  select count(*) into v_sem_registro from public.pre_agendamentos p
   where p.criado_em >= greatest(v_ini, coalesce(v_desde, now())) and not exists (select 1 from public.ia_evento c where c.pre_agendamento_id = p.id and c.tipo = 'criado');

  select jsonb_build_object('total', count(*), 'assumidas_por_atendente', count(*) filter (where not c.ia_ativa))
    into v_conv from public.conversas c where c.criado_em >= greatest(v_ini, coalesce(v_desde, now()));

  return jsonb_build_object('dias', v_dias, 'desde', v_ini, 'registro_desde', v_desde, 'pedidos_sem_registro', v_sem_registro, 'resumo', v_resumo, 'alertas', v_alertas, 'abandono_por_etapa', v_abandono,
    'tempo_mediano_pronto_agendado_min', v_tempo, 'semanas', v_semanas, 'exames_problema', v_exames, 'atendentes', v_atend, 'conversas', v_conv,
    'observacao', 'Conta só os pedidos criados depois que o registro da Fase 5 começou; pedidos anteriores não entram.');
end $function$;

