-- public.app_conferir_cadastro(p_pac uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_conferir_cadastro(p_pac uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a public.app_paciente%rowtype; v_fmt text; v_n integer; v_id uuid; v_mesmo_celular boolean; v_celular_na_base boolean; v_motivo text;
begin
  select * into a from public.app_paciente where id = p_pac for update;
  if not found or a.cpf is null then return; end if;
  v_fmt := substr(a.cpf, 1, 3) || '.' || substr(a.cpf, 4, 3) || '.' || substr(a.cpf, 7, 3) || '-' || substr(a.cpf, 10, 2);
  select count(*), (array_agg(p.id))[1], coalesce(bool_or(p.telefones && array[a.telefone, '55' || a.telefone]), false)
    into v_n, v_id, v_mesmo_celular from public.pacientes p where p.cpf = a.cpf or p.cpf = v_fmt;
  v_celular_na_base := exists (select 1 from public.pacientes p where p.telefones && array[a.telefone, '55' || a.telefone]);
  if v_n = 1 and v_mesmo_celular then v_motivo := null;
  elsif v_n = 1 then v_motivo := 'cpf_com_outro_celular';
  elsif v_n > 1 then v_motivo := 'cpf_repetido_na_clinica';
  elsif v_celular_na_base then v_motivo := 'cpf_nao_bate_com_o_celular';
  end if;
  update public.app_paciente set
    paciente_sugerido_id = case when v_n = 1 and v_mesmo_celular then coalesce(paciente_sugerido_id, v_id) else paciente_sugerido_id end,
    revisar_motivo = v_motivo,
    revisao_resolvida_em = case when v_motivo is distinct from revisar_motivo then null else revisao_resolvida_em end,
    cadastro_conferido_em = now()
  where id = p_pac;
end $function$;

