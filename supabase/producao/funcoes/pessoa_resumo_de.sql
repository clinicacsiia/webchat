-- public.pessoa_resumo_de(p_ids uuid[])
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_resumo_de(p_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'conversas', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'status', x.status) order by x.atualizado_em desc), '[]'::jsonb)
                    from (select cv.id, cv.status, cv.atualizado_em from public.conversas cv where cv.id = any (p_ids) order by cv.atualizado_em desc limit 100) x),
    'abertos', (select coalesce(jsonb_agg(jsonb_build_object('conversa_id', a.conversa_id, 'exames', a.exames, 'pendente', a.passou) order by a.quando), '[]'::jsonb)
                  from public.v_agendamento_aberto a where a.conversa_id = any (p_ids)),
    'pedidos', public.pessoa_pedidos_de(p_ids))
$function$;

