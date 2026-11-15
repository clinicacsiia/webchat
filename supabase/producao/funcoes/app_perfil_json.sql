-- public.app_perfil_json(p_pac uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_perfil_json(p_pac uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'nome', a.nome, 'nascimento', a.nascimento, 'telefone', a.telefone, 'selecao', a.ultima_selecao, 'email', a.email,
    'cpf_salvo', a.cpf is not null, 'cpf_mascara', public.app_cpf_mascara(a.cpf),
    'filhos', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'nome', f.nome, 'nascimento', f.nascimento, 'cpf_salvo', f.cpf is not null, 'cpf_mascara', public.app_cpf_mascara(f.cpf))
                                         order by f.criado_em, f.id)
                        from public.app_filho f where f.responsavel_id = a.id and f.removido_em is null), '[]'::jsonb),
    'confiaveis', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nome', c.nome, 'telefone', c.telefone, 'relacao', c.relacao,
                              'vinculado', c.vinculado_em is not null, 'codigo', case when c.vinculado_em is null then c.codigo end,
                              'codigo_invalido', c.vinculado_em is null and c.codigo_falhas >= 5) order by c.criado_em, c.id)
                            from public.app_contato_confianca c where c.responsavel_id = a.id and c.removido_em is null), '[]'::jsonb),
    'marcacoes', public.app_marcacoes_json(a.id),
    'confiam_em_mim', coalesce((select jsonb_agg(jsonb_build_object('contato_id', c.id, 'titular_nome', t.nome,
                              'filhos', coalesce((select jsonb_agg(jsonb_build_object('nome', f.nome, 'nascimento', f.nascimento) order by f.criado_em, f.id)
                                                  from public.app_filho f where f.responsavel_id = t.id and f.removido_em is null), '[]'::jsonb),
                              'marcacoes', public.app_marcacoes_json(t.id)) order by c.vinculado_em, c.id)
                            from public.app_contato_confianca c join public.app_paciente t on t.id = c.responsavel_id
                            where c.vinculado_a = a.id and c.removido_em is null and c.vinculado_em is not null), '[]'::jsonb))
  from public.app_paciente a where a.id = p_pac $function$;

