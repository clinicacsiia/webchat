-- public.painel_app_revisoes()
-- Pode executar: authenticated
CREATE OR REPLACE FUNCTION public.painel_app_revisoes()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Só a equipe vê as revisões.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(r order by r ->> 'criado_em' desc) from (
    select jsonb_build_object('id', a.id, 'nome', a.nome, 'celular', a.telefone, 'nascimento', a.nascimento, 'cpf_mascara', public.app_cpf_mascara(a.cpf),
      'motivo', coalesce(a.revisar_motivo, 'celular_na_base_sem_vinculo'),
      'cadastros_com_o_celular', (select count(*) from public.pacientes p where p.telefones && array[a.telefone, '55' || a.telefone]),
      'criado_em', a.criado_em) as r
    from public.app_paciente a
    where a.revisar_motivo is not null
       or (a.paciente_sugerido_id is null and a.revisao_resolvida_em is null and exists (select 1 from public.pacientes p where p.telefones && array[a.telefone, '55' || a.telefone]))
    order by a.criado_em desc limit 300) x), '[]'::jsonb);
end $function$;

