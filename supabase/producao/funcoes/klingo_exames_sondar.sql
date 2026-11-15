-- public.klingo_exames_sondar(p_n integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_exames_sondar(p_n integer DEFAULT 15)
 RETURNS SETOF integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with cfg as (select greatest(5, coalesce(nullif(public.klingo_cfg('klingo_exames_vazio_min', '60'), '')::int, 60)) as vazio,
                      greatest(5, coalesce(nullif(public.klingo_cfg('klingo_exames_tem_min', '120'), '')::int, 120)) as tem)
  select f.id
    from public.fluxo_exames f
    join public.klingo_exame_api k on k.id = f.id
    left join public.klingo_proc_api x on x.procedimento_id = f.id
    cross join cfg
   where x.procedimento_id is null
      or greatest(x.com_horario_em, x.vazio_em) is null
      or greatest(x.com_horario_em, x.vazio_em) < now() - make_interval(mins =>
           case when x.com_horario_em is null or (x.vazio_em is not null and x.vazio_em > x.com_horario_em) then cfg.vazio else cfg.tem end)
   order by (x.procedimento_id is null) desc, greatest(x.com_horario_em, x.vazio_em) nulls first, f.demanda desc, f.id
   limit greatest(1, least(coalesce(p_n, 15), 40))
$function$;

