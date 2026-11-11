-- public.medico_klingo()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.medico_klingo()
 RETURNS TABLE(profissional text, unidade text, especialidade text, consulta boolean, sala boolean, dias integer[], hora_ini text, hora_fim text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.profissional, a.unidade,
         string_agg(distinct initcap(lower(a.especialidade)), ' / '),
         coalesce(bool_or(p.classe = 'CONSULTAS'), false),
         (a.profissional ~* '^((rm|tc|rx)$|mamografia|densitometria|ultrassonografia|eletro)'),
         array_agg(distinct a.dia_num order by a.dia_num),
         min(a.hora_ini), max(a.hora_fim)
  from public.catalogo_agenda a left join public.catalogo_procedimento p on p.id = a.procedimento_id
  where a.vig_fim >= current_date and a.profissional !~* 'teste' and a.dia_num is not null and a.hora_ini is not null and a.hora_fim is not null
  group by a.profissional, a.unidade
$function$;

