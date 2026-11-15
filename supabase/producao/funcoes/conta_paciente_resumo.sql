-- public.conta_paciente_resumo()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.conta_paciente_resumo()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.app_pin_exigir_leitura();   -- PIN também no servidor (config.app_pin_servidor)
  return (select coalesce((select jsonb_build_object('conta', true, 'email', cp.email, 'nome', cp.nome, 'telefone', cp.telefone,
                                             'cadastro_salvo', cp.paciente_id is not null, 'aceitou_lgpd', cp.aceitou_lgpd_em is not null)
                     from public.contas_paciente cp where cp.id = (select auth.uid())), jsonb_build_object('conta', false)));
end $function$;

