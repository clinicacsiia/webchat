-- public.fila_posicao(p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_posicao(p_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select 1 + count(*)::int from public.fila_chegada o, public.fila_chegada m
   where m.id = p_id and o.status = 'aguardando' and public.fila_dia(o.chegou_em) = public.fila_dia(m.chegou_em)
     and (o.chegou_em, o.id) < (m.chegou_em, m.id)
$function$;

