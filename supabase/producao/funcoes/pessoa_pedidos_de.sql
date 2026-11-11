-- public.pessoa_pedidos_de(p_ids uuid[])
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_pedidos_de(p_ids uuid[])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('conversa_id', y.conversa_id, 'status', y.status, 'exames', y.exames)
           order by case y.status when 'agendado' then 0 when 'pronto' then 1 else 2 end, y.criado_em desc), '[]'::jsonb)
    from (select pa.conversa_id, pa.status, pa.criado_em,
                 coalesce(nullif((select string_agg(coalesce(nullif(i.procedimento, ''), i.modalidade), ' + ' order by i.id)
                                    from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo), ''), nullif(pa.procedimento, '')) as exames
            from public.pre_agendamentos pa where pa.conversa_id = any (p_ids)) y
   where y.exames is not null
$function$;

