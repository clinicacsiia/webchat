-- public.app_pessoa_cpf_salvar(p_token text, p_pessoa text, p_cpf text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_pessoa_cpf_salvar(p_token text, p_pessoa text, p_cpf text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; v_cpf text := nullif(regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'), ''); v_id uuid;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if v_cpf is not null and not public.fluxo_cpf_ok(v_cpf) then return jsonb_build_object('ok', false, 'erro', 'cpf', 'mensagem', 'Os números do CPF não conferem. Confira, por favor.'); end if;
  if p_pessoa = 'eu' then
    update public.app_paciente set cpf = v_cpf, atualizado_em = now() where id = s.o_pac;
  elsif coalesce(p_pessoa, '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    update public.app_filho set cpf = v_cpf where id = p_pessoa::uuid and responsavel_id = s.o_pac and removido_em is null returning id into v_id;
    if v_id is null then return jsonb_build_object('ok', false, 'erro', 'pessoa', 'mensagem', 'Pessoa não encontrada no seu cadastro.'); end if;
  else
    return jsonb_build_object('ok', false, 'erro', 'pessoa', 'mensagem', 'Pessoa não encontrada no seu cadastro.');
  end if;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $function$;

