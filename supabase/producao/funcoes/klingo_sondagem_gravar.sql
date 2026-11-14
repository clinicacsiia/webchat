-- public.klingo_sondagem_gravar(p_proc integer, p_tem boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_sondagem_gravar(p_proc integer, p_tem boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.klingo_proc_api (procedimento_id, com_horario_em, vazio_em)
  values (p_proc, case when p_tem then now() end, case when not p_tem then now() end)
  on conflict (procedimento_id) do update set com_horario_em = case when p_tem then now() else public.klingo_proc_api.com_horario_em end,
                                              vazio_em = case when not p_tem then now() else public.klingo_proc_api.vazio_em end
$function$;

