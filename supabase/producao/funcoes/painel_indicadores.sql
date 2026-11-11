-- public.painel_indicadores(p_dias integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores(p_dias integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ini timestamptz := case when coalesce(p_dias, 0) > 0 then now() - make_interval(days => least(p_dias, 3650)) else '-infinity'::timestamptz end;
  v_conv jsonb; v_ped jsonb; v_dias jsonb; v_desde timestamptz;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'total', count(*),
    'pessoas', count(distinct c.contato_id),
    'finalizadas', count(*) filter (where c.status = 'encerrada'),
    'em_andamento', count(*) filter (where c.status <> 'encerrada')
  ) into v_conv from public.conversas c where c.criado_em >= v_ini;

  select jsonb_build_object(
    'conversas_com_pedido_completo', count(distinct p.conversa_id) filter (where p.status in ('pronto', 'agendado')),
    'agendados', count(*) filter (where p.status = 'agendado'),
    'agendados_pela_ia', count(*) filter (where p.status = 'agendado' and p.agendado_auto_em is not null),
    'agendados_pela_equipe', count(*) filter (where p.status = 'agendado' and p.agendado_auto_em is null),
    'prontos_esperando_recepcao', count(*) filter (where p.status = 'pronto'),
    'cancelados', count(*) filter (where p.status = 'cancelado'),
    'rascunhos', count(*) filter (where p.status = 'rascunho')
  ) into v_ped from public.pre_agendamentos p where p.criado_em >= v_ini;

  select coalesce(jsonb_agg(jsonb_build_object('dia', d.dia, 'conversas', d.conversas, 'finalizadas', d.finalizadas,
           'pedidos_completos', d.pedidos, 'agendados', d.agendados) order by d.dia), '[]'::jsonb) into v_dias
  from (
    select x.dia,
      (select count(*) from public.conversas c where (c.criado_em at time zone 'America/Sao_Paulo')::date = x.dia) conversas,
      (select count(*) from public.conversas c where c.status = 'encerrada' and (c.criado_em at time zone 'America/Sao_Paulo')::date = x.dia) finalizadas,
      (select count(distinct p.conversa_id) from public.pre_agendamentos p where p.status in ('pronto', 'agendado') and (p.criado_em at time zone 'America/Sao_Paulo')::date = x.dia) pedidos,
      (select count(*) from public.pre_agendamentos p where p.status = 'agendado' and (p.criado_em at time zone 'America/Sao_Paulo')::date = x.dia) agendados
    from (select distinct (c.criado_em at time zone 'America/Sao_Paulo')::date dia from public.conversas c where c.criado_em >= v_ini) x
  ) d;

  select min(c.criado_em) into v_desde from public.conversas c;

  return jsonb_build_object('periodo_dias', coalesce(p_dias, 0), 'desde', v_desde, 'gerado_em', now(),
    'conversas', v_conv, 'pedidos', v_ped, 'por_dia', v_dias);
end $function$;

