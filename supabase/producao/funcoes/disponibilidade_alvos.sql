-- public.disponibilidade_alvos(p_max integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_alvos(p_max integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('pedido_id', x.id, 'conversa_id', x.conversa_id, 'de', greatest(x.data_ini, (now() at time zone 'America/Bahia')::date), 'ate', x.data_fim, 'modo', x.modo) order by x.ultima_verificacao_em nulls first), '[]'::jsonb)
    from (select p.*, public.klingo_modo(p.conversa_id, 'previsao_monitor_modo') as modo from public.disponibilidade_pedido p
           where p.estado = 'ativa' and p.expira_em > now() and (p.ultima_verificacao_em is null or p.ultima_verificacao_em < now() - interval '9 minutes')
           order by p.ultima_verificacao_em nulls first limit greatest(p_max, 1) * 4) x
   where x.modo in ('sombra', 'teste', 'sim') and x.data_fim >= (now() at time zone 'America/Bahia')::date limit greatest(p_max, 1)
$function$;

