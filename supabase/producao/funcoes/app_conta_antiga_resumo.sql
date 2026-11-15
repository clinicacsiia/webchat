-- public.app_conta_antiga_resumo()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_conta_antiga_resumo()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare cp public.contas_paciente%rowtype; p public.pacientes%rowtype; v_tel text; v_nome text; v_nasc date; v_cpf text; v_falta jsonb := '[]'::jsonb;
begin
  select * into cp from public.contas_paciente where id = (select auth.uid());
  if not found then return jsonb_build_object('ok', true, 'conta', false); end if;
  if exists (select 1 from public.app_paciente where conta_antiga_id = cp.id) then
    return jsonb_build_object('ok', true, 'conta', true, 'migrada', true, 'email', cp.email);
  end if;
  if cp.paciente_id is not null then select * into p from public.pacientes where id = cp.paciente_id; end if;
  v_tel := coalesce(public.app_tel_br(cp.telefone), (select public.app_tel_br(x) from unnest(coalesce(p.telefones, '{}'::text[])) x where public.app_tel_br(x) is not null limit 1));
  v_nome := case when public.app_nome_ok(cp.nome) then btrim(cp.nome) when public.app_nome_ok(p.nome) then btrim(p.nome) end;
  v_nasc := case when p.dt_nasc between date '1900-01-01' and public.app_hoje() then p.dt_nasc end;
  v_cpf := case when regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g') ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(regexp_replace(p.cpf, '\D', '', 'g')) then regexp_replace(p.cpf, '\D', '', 'g') end;
  if v_nome is null then v_falta := v_falta || '"nome"'::jsonb; end if;
  if v_tel is null then v_falta := v_falta || '"telefone"'::jsonb; end if;
  if v_nasc is null then v_falta := v_falta || '"nascimento"'::jsonb; end if;
  return jsonb_build_object('ok', true, 'conta', true, 'migrada', false, 'email', cp.email, 'nome', v_nome, 'telefone', v_tel, 'nascimento', v_nasc,
    'cpf_mascara', public.app_cpf_mascara(v_cpf), 'falta', v_falta);
end $function$;

