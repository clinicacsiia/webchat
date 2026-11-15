-- public.klingo_exames_cobertura()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_exames_cobertura()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'exames_no_chat', (select count(*) from public.fluxo_exames),
    'na_api', (select count(*) from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id),
    'conferidos', (select count(*) from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id join public.klingo_proc_api x on x.procedimento_id = f.id),
    'com_horario', (select count(*) from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id join public.klingo_proc_api x on x.procedimento_id = f.id
                     where x.com_horario_em is not null and (x.vazio_em is null or x.com_horario_em >= x.vazio_em)),
    'sem_horario', (select count(*) from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id join public.klingo_proc_api x on x.procedimento_id = f.id
                     where x.vazio_em is not null and (x.com_horario_em is null or x.vazio_em > x.com_horario_em)),
    'faltam_conferir', (select count(*) from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id left join public.klingo_proc_api x on x.procedimento_id = f.id where x.procedimento_id is null),
    'fora_da_api', (select count(*) from public.fluxo_exames f where not exists (select 1 from public.klingo_exame_api k where k.id = f.id)),
    'mais_antiga_h', (select round(extract(epoch from now() - min(greatest(x.com_horario_em, x.vazio_em))) / 3600, 1)
                       from public.fluxo_exames f join public.klingo_exame_api k on k.id = f.id join public.klingo_proc_api x on x.procedimento_id = f.id))
$function$;

