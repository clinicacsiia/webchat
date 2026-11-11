-- public.conta_paciente_vinculo_estado()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_paciente_vinculo_estado()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select jsonb_build_object(
      'ligada', cp.paciente_id is not null,
      'verificar_aberto', exists (select 1 from public.vinculo_solicitacoes s where s.conta_id = cp.id and s.tipo = 'verificar' and s.status = 'aberta'),
      'alteracao_aberta', exists (select 1 from public.vinculo_solicitacoes s where s.conta_id = cp.id and s.tipo = 'alterar' and s.status = 'aberta'))
    from public.contas_paciente cp where cp.id = (select auth.uid())), jsonb_build_object('ligada', false, 'verificar_aberto', false, 'alteracao_aberta', false))
$function$;

