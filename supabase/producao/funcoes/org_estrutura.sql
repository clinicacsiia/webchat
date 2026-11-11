-- public.org_estrutura()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.org_estrutura()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_nivel text := public.org_nivel(); v_uid uuid := (select auth.uid());
begin
  if v_nivel is null or v_nivel = 'atendente' then raise exception 'Sem permissão para ver a estrutura.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'nivel', v_nivel,
    'modo', coalesce((select valor from public.config where chave = 'permissao_modo'), 'desligado'),
    'unidades', coalesce((select jsonb_agg(jsonb_build_object('chave', u.chave, 'rotulo', u.rotulo) order by u.ordem) from public.unidade_config u where u.ativo), '[]'::jsonb),
    'agentes', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'nome', a.nome, 'papel', a.papel) order by a.nome) from public.agentes a where a.ativo), '[]'::jsonb),
    'globais', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'funcao', m.funcao, 'agente_id', m.agente_id, 'agente', a.nome, 'rotulo', m.rotulo) order by m.funcao, a.nome)
                          from public.org_membro m left join public.agentes a on a.id = m.agente_id where m.equipe_id is null and m.ativo), '[]'::jsonb),
    'equipes', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'nome', e.nome, 'unidade', e.unidade, 'transversal', e.transversal, 'ativa', e.ativa,
        'membros', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'funcao', m.funcao, 'agente_id', m.agente_id, 'agente', a.nome, 'rotulo', m.rotulo, 'ativo', m.ativo)
                                    order by array_position(array['supervisor', 'atendente'], m.funcao), m.id)
                               from public.org_membro m left join public.agentes a on a.id = m.agente_id where m.equipe_id = e.id), '[]'::jsonb)) order by e.nome)
      from public.org_equipe e
     where v_nivel in ('ti', 'gerente') or exists (select 1 from public.org_membro s where s.equipe_id = e.id and s.agente_id = v_uid and s.funcao = 'supervisor' and s.ativo)), '[]'::jsonb));
end $function$;

