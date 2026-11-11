-- public.medico_procs_klingo()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.medico_procs_klingo()
 RETURNS TABLE(profissional text, procedimento_id integer, procedimento text, especialidade text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.profissional, a.procedimento_id, min(coalesce(p.nome, a.procedimento)), min(initcap(lower(a.especialidade)))
  from public.catalogo_agenda a left join public.catalogo_procedimento p on p.id = a.procedimento_id
  where a.vig_fim >= current_date and a.profissional !~* 'teste' and a.procedimento_id is not null and a.dia_num is not null and a.hora_ini is not null and a.hora_fim is not null
    and a.profissional !~* '^((rm|tc|rx)$|mamografia|densitometria|ultrassonografia|eletro)'
  group by a.profissional, a.procedimento_id
$function$;

