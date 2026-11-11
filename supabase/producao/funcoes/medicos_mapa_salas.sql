-- public.medicos_mapa_salas()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.medicos_mapa_salas()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.medico_admin();
  return coalesce((
    with w as (
      select distinct a.unidade, a.local, a.profissional, a.dia_num, a.hora_ini, a.hora_fim
      from public.catalogo_agenda a
      where a.vig_fim >= current_date and a.profissional !~* 'teste' and nullif(btrim(a.local), '') is not null and a.dia_num is not null and a.hora_ini is not null and a.hora_fim is not null
        and a.profissional !~* '^((rm|tc|rx)$|mamografia|densitometria|ultrassonografia|eletro)'
    ), o as (
      select w.*, max(w.hora_fim) over (partition by w.unidade, w.local, w.profissional, w.dia_num order by w.hora_ini, w.hora_fim rows between unbounded preceding and 1 preceding) as mx from w
    ), g as (
      select o.*, sum(case when o.mx is null or o.hora_ini > o.mx then 1 else 0 end) over (partition by o.unidade, o.local, o.profissional, o.dia_num order by o.hora_ini, o.hora_fim) as grp from o
    ), m as (
      select g.unidade, g.local, g.profissional, g.dia_num as dia, min(g.hora_ini) as ini, max(g.hora_fim) as fim from g group by g.unidade, g.local, g.profissional, g.dia_num, g.grp
    )
    select jsonb_agg(jsonb_build_object(
      'unidade', m.unidade, 'local', m.local, 'dia', m.dia, 'ini', m.ini, 'fim', m.fim, 'profissional', m.profissional,
      'bloqueado', public.profissional_bloqueado(m.profissional),
      'choque', coalesce((select jsonb_agg(distinct x.profissional) from m x where x.unidade = m.unidade and x.local = m.local and x.dia = m.dia and x.profissional <> m.profissional and x.ini < m.fim and m.ini < x.fim), '[]'::jsonb),
      'duplo', exists (select 1 from m x where x.unidade = m.unidade and x.profissional = m.profissional and x.dia = m.dia and x.local <> m.local and x.ini < m.fim and m.ini < x.fim))
      order by m.unidade, m.local, m.dia, m.ini, m.profissional)
    from m), '[]'::jsonb);
end $function$;

