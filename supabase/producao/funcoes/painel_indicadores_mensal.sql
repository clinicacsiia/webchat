-- public.painel_indicadores_mensal(p_meses integer, p_unidade text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_indicadores_mensal(p_meses integer DEFAULT 6, p_unidade text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_mes_atual date := date_trunc('month', (now() at time zone 'America/Sao_Paulo'))::date;
  v_n integer := least(greatest(coalesce(p_meses, 6), 1), 12);
  v_ini date;
  v_un text := case when lower(coalesce(p_unidade, '')) in ('csi', 'rmtc', 'desenvoar') then lower(p_unidade) end;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then
    raise exception 'Somente administrador e atendente veem os indicadores.' using errcode = '42501';
  end if;
  v_ini := (v_mes_atual - ((v_n - 1) || ' months')::interval)::date;
  return jsonb_build_object(
    'de', v_ini, 'ate', v_mes_atual, 'unidade', v_un, 'gerado_em', now(),
    'meses', coalesce((
      with base as (
        select date_trunc('month', e.agendado_para at time zone 'America/Sao_Paulo')::date as mes, e.status,
               case when e.procedimento ~* '^consulta' then 'consulta' else 'exame' end as tipo
          from public.jornada_exame e
         where e.status <> 'pedido' and e.agendado_para is not null
           and e.marcacao_id not in (select 'm' || z.m from public.klingo_conferencia z join public.conversas c on c.id = z.conversa_id where c.teste)
           and (v_un is null or public.unidade_chave(e.unidade) is null or public.unidade_chave(e.unidade) = v_un))
      select jsonb_agg(jsonb_build_object('mes', to_char(m.d, 'YYYY-MM'),
               'total', t.todos -> 'total', 'atendidos', t.todos -> 'atendidos', 'faltaram', t.todos -> 'faltaram', 'cancelados', t.todos -> 'cancelados',
               'remarcados', t.todos -> 'remarcados', 'por_vir', t.todos -> 'por_vir', 'consulta', t.co, 'exame', t.ex) order by m.d)
        from generate_series(v_ini, v_mes_atual, interval '1 month') as m(d)
        cross join lateral (
          select
            (select jsonb_build_object('total', count(*), 'atendidos', count(*) filter (where status = 'atendido'), 'faltaram', count(*) filter (where status = 'faltou'),
                    'cancelados', count(*) filter (where status = 'cancelado'), 'remarcados', count(*) filter (where status = 'remarcado'), 'por_vir', count(*) filter (where status in ('agendado', 'confirmado')))
               from base b where b.mes = m.d) as todos,
            (select jsonb_build_object('total', count(*), 'atendidos', count(*) filter (where status = 'atendido'), 'faltaram', count(*) filter (where status = 'faltou'),
                    'cancelados', count(*) filter (where status = 'cancelado'), 'remarcados', count(*) filter (where status = 'remarcado'), 'por_vir', count(*) filter (where status in ('agendado', 'confirmado')))
               from base b where b.mes = m.d and b.tipo = 'consulta') as co,
            (select jsonb_build_object('total', count(*), 'atendidos', count(*) filter (where status = 'atendido'), 'faltaram', count(*) filter (where status = 'faltou'),
                    'cancelados', count(*) filter (where status = 'cancelado'), 'remarcados', count(*) filter (where status = 'remarcado'), 'por_vir', count(*) filter (where status in ('agendado', 'confirmado')))
               from base b where b.mes = m.d and b.tipo = 'exame') as ex
        ) t), '[]'::jsonb));
end $function$;
