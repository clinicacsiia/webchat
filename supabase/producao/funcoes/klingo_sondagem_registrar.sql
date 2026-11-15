-- public.klingo_sondagem_registrar(p_proc integer, p_tem boolean, p_primeiro date)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_sondagem_registrar(p_proc integer, p_tem boolean, p_primeiro date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.klingo_proc_api (procedimento_id, com_horario_em, vazio_em, primeiro_dia)
  values (p_proc, case when p_tem then now() end, case when not p_tem then now() end, case when p_tem then p_primeiro end)
  on conflict (procedimento_id) do update set
    com_horario_em = case when p_tem then now() else public.klingo_proc_api.com_horario_em end,
    vazio_em = case when not p_tem then now() else public.klingo_proc_api.vazio_em end,
    primeiro_dia = case when p_tem then p_primeiro else null end
$function$;

