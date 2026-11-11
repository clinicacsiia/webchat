-- public.agenda_cobre(p_procs integer[])
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_cobre(p_procs integer[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.catalogo_agenda a
    join public.catalogo_procedimento pm on pm.id = a.procedimento_id
    left join public.agenda_modalidade_local ml on ml.modalidade = pm.modalidade
    where a.procedimento_id = any(p_procs) and a.vig_fim >= current_date and a.profissional !~* 'teste' and not public.profissional_bloqueado(a.profissional)
      and (ml.local_padrao is null or a.local ~* ml.local_padrao)
    group by a.unidade, a.local, a.profissional
    having count(distinct a.procedimento_id) = (select count(distinct x) from unnest(p_procs) x))
$function$;

