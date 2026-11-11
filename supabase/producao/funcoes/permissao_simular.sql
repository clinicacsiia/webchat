-- public.permissao_simular()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.permissao_simular()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Apenas administradores.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'modo', coalesce((select valor from public.config where chave = 'permissao_modo'), 'desligado'),
    'sem_unidade_abertas', (select count(*) from public.conversas where not teste and status <> 'encerrada' and coalesce(unidade_responsavel, unidade_inicial) is null),
    'pessoas', coalesce((select jsonb_agg(x order by x.nome) from (
      select a.id, a.nome, a.papel, public.org_nivel_de(a.id, a.papel) as nivel,
             count(c.id) filter (where c.status <> 'encerrada') as abertas,
             count(c.id) filter (where c.status <> 'encerrada' and public.org_pode_ver(a.id, a.papel, c.agente_id, coalesce(c.unidade_responsavel, c.unidade_inicial))) as abertas_visiveis,
             count(c.id) as total,
             count(c.id) filter (where public.org_pode_ver(a.id, a.papel, c.agente_id, coalesce(c.unidade_responsavel, c.unidade_inicial))) as total_visiveis
        from public.agentes a cross join public.conversas c where a.ativo and not c.teste group by a.id, a.nome, a.papel) x), '[]'::jsonb));
end $function$;

