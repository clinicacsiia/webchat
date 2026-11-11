-- public.ia_exemplos(p_dias integer, p_limite integer)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.ia_exemplos(p_dias integer DEFAULT 28, p_limite integer DEFAULT 40)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_dias int := least(greatest(coalesce(p_dias, 28), 7), 365); v_ids uuid[];
  v_lim int := least(greatest(coalesce(p_limite, 40), 1), 200); v_res jsonb;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then
    raise exception 'Somente o administrador vê o relatório de aprendizado.' using errcode = '42501';
  end if;
  v_ids := array(select c.id from public.ia_coorte(now() - make_interval(days => v_dias)) c);
  select coalesce(jsonb_agg(x.j order by x.criado_em desc), '[]'::jsonb) into v_res
    from (select d.criado_em, d.j
            from (select distinct on (e.pre_agendamento_id, case when e.tipo = 'conferencia' then e.para else 'cancelado' end)
                         e.criado_em,
                         jsonb_build_object('quando', e.criado_em, 'caso', case when e.tipo = 'conferencia' then e.para else 'cancelado' end, 'por', e.por,
                           'exames', coalesce(e.contexto -> 'exames', '[]'::jsonb), 'plano', e.contexto ->> 'plano', 'unidade', e.contexto ->> 'unidade',
                           'etapa', e.contexto ->> 'etapa', 'detalhe', e.detalhe) as j
                    from public.ia_evento e
                   where e.pre_agendamento_id = any(v_ids) and ((e.tipo = 'conferencia' and e.para <> 'confirmado') or (e.tipo = 'status' and e.para = 'cancelado'))
                   order by e.pre_agendamento_id, case when e.tipo = 'conferencia' then e.para else 'cancelado' end, e.criado_em desc) d
           order by d.criado_em desc limit v_lim) x;
  return v_res;
end $function$;

