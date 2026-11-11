-- public.vinculo_listar()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.vinculo_listar()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê os vínculos.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'tipo', s.tipo, 'criado_em', s.criado_em, 'batem', s.batem, 'diferem', s.diferem,
      'conta', jsonb_build_object('email', cp.email, 'nome', coalesce(s.conta_nome, cp.nome), 'telefone', coalesce(s.conta_telefone, cp.telefone)),
      'novo', jsonb_build_object('email', s.novo_email, 'telefone', s.novo_telefone),
      'cadastro', jsonb_build_object('nome', p.nome, 'email', p.email, 'telefones', p.telefones, 'dt_nasc', p.dt_nasc, 'ultima_visita_em', p.ultima_visita_em))
      order by s.criado_em)
    from public.vinculo_solicitacoes s
    join public.contas_paciente cp on cp.id = s.conta_id
    join public.pacientes p on p.id = s.paciente_id
    where s.status = 'aberta'), '[]'::jsonb);
end $function$;

