-- public.fila_listar()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_listar()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.fila_exige_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'nome', p.nome, 'email', a.email_informado, 'status', a.status,
             'created_at', a.created_at, 'tentativas_falhas', a.tentativas_falhas,
             'bloqueado', a.bloqueado_em is not null, 'links_enviados', a.links_enviados)
           order by (a.status = 'concluido'), a.created_at, a.id)
      from public.atendimentos a join public.pacientes p on p.id = a.paciente_id
     where a.status <> 'concluido' or a.atualizado_em > now() - interval '12 hours'), '[]'::jsonb);
end $function$;

