-- public.convenios_suspensos()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.convenios_suspensos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce(public.org_nivel(), '') not in ('ti', 'gerente') then raise exception 'Somente TI e gerência.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('operadora', c.operadora, 'motivo', c.suspenso_motivo, 'suspenso_em', c.suspenso_em, 'revisar_em', c.suspenso_ate,
            'revisar_agora', c.suspenso_ate <= now(), 'por', (select a.nome from public.agentes a where a.id = c.suspenso_por)) order by c.suspenso_em)
          from public.convenio_config c where c.suspenso_em is not null), '[]'::jsonb);
end $function$;

