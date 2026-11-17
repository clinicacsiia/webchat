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
      select jsonb_agg(jsonb_build_object('mes', to_char(m.d, 'YYYY-MM'),
               'total', coalesce(x.total, 0), 'atendidos', coalesce(x.atendidos, 0), 'faltaram', coalesce(x.faltaram, 0),
               'cancelados', coalesce(x.cancelados, 0), 'remarcados', coalesce(x.remarcados, 0), 'por_vir', coalesce(x.por_vir, 0)) order by m.d)
        from generate_series(v_ini, v_mes_atual, interval '1 month') as m(d)
        left join (
          select date_trunc('month', e.agendado_para at time zone 'America/Sao_Paulo')::date as mes,
                 count(*) as total,
                 count(*) filter (where e.status = 'atendido') as atendidos,
                 count(*) filter (where e.status = 'faltou') as faltaram,
                 count(*) filter (where e.status = 'cancelado') as cancelados,
                 count(*) filter (where e.status = 'remarcado') as remarcados,
                 count(*) filter (where e.status in ('agendado', 'confirmado')) as por_vir
            from public.jornada_exame e
           where e.status <> 'pedido' and e.agendado_para is not null
             and (v_un is null or public.unidade_chave(e.unidade) is null or public.unidade_chave(e.unidade) = v_un)
           group by 1) x on x.mes = m.d), '[]'::jsonb));
end $function$;
