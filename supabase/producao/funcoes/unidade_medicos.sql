-- public.unidade_medicos(p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.unidade_medicos(p_chave text)
 RETURNS TABLE(nome text, especialidade text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.profissional, string_agg(distinct initcap(lower(a.especialidade)), ' / ' order by initcap(lower(a.especialidade)))
  from public.unidade_config u
  join public.catalogo_agenda a on a.unidade = u.catalogo
  join public.catalogo_procedimento p on p.id = a.procedimento_id
  where u.chave = p_chave and u.ativo
    and p.classe = 'CONSULTAS'
    and a.vig_fim >= current_date
    and a.profissional !~* '(teste|^eletro)' and not public.profissional_bloqueado(a.profissional)
    and coalesce(a.especialidade, '') !~* 'anestesi'
  group by a.profissional
  order by a.profissional;
$function$;

