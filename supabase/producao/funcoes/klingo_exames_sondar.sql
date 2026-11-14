-- public.klingo_exames_sondar(p_n integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_exames_sondar(p_n integer DEFAULT 15)
 RETURNS SETOF integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p.id from public.catalogo_procedimento p
   where p.ativo and p.modalidade in ('RM', 'TC', 'US', 'RX', 'MAMO', 'DENSITO')
     and exists (select 1 from public.catalogo_agenda a where a.procedimento_id = p.id and a.vig_fim >= current_date and a.profissional !~* 'teste')
     and coalesce((select greatest(x.com_horario_em, x.vazio_em) from public.klingo_proc_api x where x.procedimento_id = p.id), 'epoch'::timestamptz) < now() - interval '3 days'
   order by coalesce(p.demanda_90d, 0) desc, p.id limit greatest(1, least(coalesce(p_n, 15), 40))
$function$;

