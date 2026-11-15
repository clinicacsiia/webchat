-- public.app_conta_antiga_filhos()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_conta_antiga_filhos()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare cp public.contas_paciente%rowtype; p public.pacientes%rowtype; v_nome text; v_nasc date;
begin
  select * into cp from public.contas_paciente where id = (select auth.uid());
  if not found or exists (select 1 from public.app_paciente where conta_antiga_id = cp.id) then return jsonb_build_object('ok', true, 'filhos', '[]'::jsonb); end if;
  if cp.paciente_id is not null then select * into p from public.pacientes where id = cp.paciente_id; end if;
  v_nome := case when public.app_nome_ok(cp.nome) then btrim(cp.nome) when public.app_nome_ok(p.nome) then btrim(p.nome) end;
  v_nasc := case when p.dt_nasc between date '1900-01-01' and public.app_hoje() then p.dt_nasc end;
  return jsonb_build_object('ok', true, 'filhos', coalesce((select jsonb_agg(jsonb_build_object(
      'nome', h.nome, 'nascimento', h.nasc, 'cpf_mascara', public.app_cpf_mascara(h.cpf), 'atendimentos', h.atendimentos,
      'mesmo_nome', v_nome is not null and h.chave = public.app_norm(v_nome),
      'mesmo_cadastro', v_nome is not null and h.chave = public.app_norm(v_nome) and h.nasc is not null and h.nasc = v_nasc) order by h.nome)
    from public.app_conta_antiga_historico_filhos(cp.id) h), '[]'::jsonb));
end $function$;

