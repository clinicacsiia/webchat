-- public.conta_paciente_resumo()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_paciente_resumo()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select jsonb_build_object('conta', true, 'email', cp.email, 'nome', cp.nome, 'telefone', cp.telefone,
                                             'cadastro_salvo', cp.paciente_id is not null, 'aceitou_lgpd', cp.aceitou_lgpd_em is not null)
                     from public.contas_paciente cp where cp.id = (select auth.uid())), jsonb_build_object('conta', false))
$function$;

