-- public.painel_app_pendencias_resumo()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.painel_app_pendencias_resumo()
 RETURNS jsonb
 LANGUAGE plpgsql STABLE
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê as pendências.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'solicitacoes', (select count(distinct m.grupo) from public.app_marcacao m where m.status = 'solicitada'),
    'revisoes', (select count(*) from public.app_paciente a
                  where a.revisar_motivo is not null
                     or (a.paciente_sugerido_id is null and a.revisao_resolvida_em is null and exists (select 1 from public.pacientes p where p.telefones && array[a.telefone, '55' || a.telefone]))),
    'contas_antigas', (select count(*) from public.contas_paciente c where not exists (select 1 from public.app_paciente a where a.conta_antiga_id = c.id)),
    'sem_cpf', (select count(*) from public.app_paciente a where a.cpf is null),
    'acesso_rapido', (select count(*) from public.app_paciente),
    'codigos', (select count(*) from public.app_codigo_email c where c.usado_em is null and c.descartado_em is null and c.expira_em > now() and c.validado_em is null));
end $function$;

