-- public.painel_app_solicitacoes(p_status text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_app_solicitacoes(p_status text DEFAULT 'solicitada'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê as solicitações.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(g order by g ->> 'criado_em') from (
    select jsonb_build_object('grupo', m.grupo, 'criado_em', min(m.criado_em), 'responsavel', p.nome, 'celular', p.telefone,
      'cadastro_sugerido', p.paciente_sugerido_id is not null,
      'pessoas', jsonb_agg(jsonb_build_object('nome', m.pessoa_nome, 'nascimento', m.pessoa_nascimento, 'filho', m.filho_id is not null) order by m.pessoa_nome),
      'exame', m.exame, 'data_preferida', m.data_preferida, 'turno', m.turno, 'obs', m.obs, 'status', m.status) as g
    from public.app_marcacao m join public.app_paciente p on p.id = m.responsavel_id
    where m.status = coalesce(nullif(p_status, ''), 'solicitada')
    group by m.grupo, p.id, m.exame, m.data_preferida, m.turno, m.obs, m.status limit 500) x), '[]'::jsonb);
end $function$;

