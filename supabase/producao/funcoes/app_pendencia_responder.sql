-- public.app_pendencia_responder(p_token text, p_pessoa text, p_campo text, p_valor text)
-- Pode executar: anon, authenticated
CREATE OR REPLACE FUNCTION public.app_pendencia_responder(p_token text, p_pessoa text, p_campo text, p_valor text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; v_cpf text; v_email text; v_id uuid;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if p_campo = 'cpf' then
    v_cpf := regexp_replace(coalesce(p_valor, ''), '\D', '', 'g');
    if not public.fluxo_cpf_ok(v_cpf) then return jsonb_build_object('ok', false, 'erro', 'cpf', 'mensagem', 'Os números do CPF não conferem. Confira, por favor.'); end if;
    if p_pessoa = 'eu' then
      update public.app_paciente set cpf = v_cpf, atualizado_em = now() where id = s.o_pac and cpf is null;
      perform public.app_conferir_cadastro(s.o_pac);
    elsif coalesce(p_pessoa, '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      update public.app_filho set cpf = v_cpf where id = p_pessoa::uuid and responsavel_id = s.o_pac and removido_em is null and cpf is null returning id into v_id;
      if v_id is null then return jsonb_build_object('ok', false, 'erro', 'pessoa', 'mensagem', 'Pessoa não encontrada no seu cadastro.'); end if;
    else
      return jsonb_build_object('ok', false, 'erro', 'pessoa', 'mensagem', 'Pessoa não encontrada no seu cadastro.');
    end if;
  elsif p_campo = 'email' and p_pessoa = 'eu' then
    v_email := lower(btrim(coalesce(p_valor, '')));
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 200 then
      return jsonb_build_object('ok', false, 'erro', 'email', 'mensagem', 'Esse e-mail não parece certo. Confira, por favor.');
    end if;
    update public.app_paciente set email = v_email, atualizado_em = now() where id = s.o_pac and email is null;
  else
    return jsonb_build_object('ok', false, 'erro', 'campo', 'mensagem', 'Não foi possível salvar.');
  end if;
  return jsonb_build_object('ok', true, 'pendencias', public.app_pendencias_lista(s.o_pac), 'perfil', public.app_perfil_json(s.o_pac));
end $function$;

