-- public.pessoa_membros(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_membros(p_conversa uuid)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select array_agg(c.id order by c.atualizado_em desc) from public.conversa_grupo g join public.conversas c on c.id = g.conversa_id
                    where g.grupo_id = (select grupo_id from public.conversa_grupo where conversa_id = p_conversa)), array[p_conversa])
$function$;

