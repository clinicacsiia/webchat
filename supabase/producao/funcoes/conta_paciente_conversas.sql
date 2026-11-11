-- public.conta_paciente_conversas()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_paciente_conversas()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', c.id, 'token', s.token, 'criado_em', (extract(epoch from c.criado_em) * 1000)::bigint,
      'tipo', coalesce(c.paciente_tipo, 'proprio'), 'nomeCrianca', case when c.paciente_tipo = 'filho' then coalesce(c.paciente_nome, '') else '' end,
      'ultima', left(coalesce(c.ultima_mensagem, ''), 120)) order by c.criado_em desc)
    from (select x.* from public.conversas x where x.conta_id = (select auth.uid()) order by x.criado_em desc limit 30) c
    join public.conversa_segredo s on s.conversa_id = c.id
    where exists (select 1 from public.contas_paciente cp where cp.id = (select auth.uid()))), '[]'::jsonb)
$function$;

