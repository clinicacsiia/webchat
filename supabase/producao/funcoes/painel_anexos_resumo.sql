-- public.painel_anexos_resumo()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_anexos_resumo()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Não autorizado.' using errcode = '28000'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('conversa_id', q.conversa_id, 'total', q.n, 'sem_conferir', q.sc, 'ultima', q.ult, 'ids', q.ids) order by q.ult desc)
    from (select a.conversa_id, count(*)::int n, (count(*) filter (where a.klingo_conferido_em is null))::int sc, max(a.criado_em) ult, jsonb_agg(a.id order by a.id) ids
          from public.conversa_anexo a where a.criado_em > now() - interval '120 days' and a.tipo = 'pedido_medico' group by a.conversa_id) q), '[]'::jsonb);
end $function$;

