-- public.agenda_horarios(p_procs integer[], p_de date, p_ate date, p_unidade text, p_profissional text, p_periodo text, p_excluir jsonb, p_antecedencia_min integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_horarios(p_procs integer[], p_de date, p_ate date, p_unidade text DEFAULT NULL::text, p_profissional text DEFAULT NULL::text, p_periodo text DEFAULT NULL::text, p_excluir jsonb DEFAULT '[]'::jsonb, p_antecedencia_min integer DEFAULT 120)
 RETURNS TABLE(data date, hora text, unidade text, local text, profissional text, duracao_min integer, chegada boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with ctx as (
    select case when public.convenio_chave(pa.plano) ~ '^(|PARTICULAR.*)$' then null else public.convenio_chave(pa.plano) end as op
    from (select 1) u left join public.pre_agendamentos pa on pa.conversa_id = nullif(current_setting('app.conversa', true), '')::uuid
  )
  select h.data, h.hora, h.unidade, h.local, h.profissional, h.duracao_min, h.chegada
  from public.agenda_horarios_klingo(p_procs, p_de, p_ate, p_unidade, p_profissional, p_periodo, p_excluir, p_antecedencia_min) h, ctx
  where not exists (
    select 1 from public.medico_regra r
    where public.norm_nome(r.profissional) = public.norm_nome(h.profissional) and public.norm_nome(r.unidade) = public.norm_nome(h.unidade)
      and ((r.dias is not null and not (extract(dow from h.data)::int = any(r.dias)))
        or (r.hora_ini is not null and h.hora < r.hora_ini)
        or (r.hora_fim is not null and (h.hora::time + make_interval(mins => case when h.chegada then 0 else h.duracao_min end)) > r.hora_fim::time)))
    and (not exists (select 1 from public.medico_turno t where public.norm_nome(t.profissional) = public.norm_nome(h.profissional) and public.norm_nome(t.unidade) = public.norm_nome(h.unidade))
      or exists (select 1 from public.medico_turno t
                 where public.norm_nome(t.profissional) = public.norm_nome(h.profissional) and public.norm_nome(t.unidade) = public.norm_nome(h.unidade)
                   and t.dia = extract(dow from h.data)::int and h.hora >= t.hora_ini
                   and (h.hora::time + make_interval(mins => case when h.chegada then 0 else h.duracao_min end)) <= t.hora_fim::time))
    and not exists (select 1 from public.medico_excecao e where e.profissional = public.norm_nome(h.profissional) and h.data between e.data_ini and e.data_fim)
    and (ctx.op is null or (
      not exists (select 1 from public.medico_particular mp where mp.profissional = public.norm_nome(h.profissional))
      and not exists (select 1 from public.medico_convenio_bloqueio b
                      where b.profissional = public.norm_nome(h.profissional) and b.operadora = ctx.op and (b.procedimento_id = 0 or b.procedimento_id = any(p_procs)))))
$function$;

