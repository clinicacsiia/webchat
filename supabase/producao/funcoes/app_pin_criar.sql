-- public.app_pin_criar(p_telefone text, p_nome text, p_nascimento text, p_pin text, p_cpf text, p_filhos jsonb, p_confianca jsonb, p_aparelho text, p_email text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_pin_criar(p_telefone text, p_nome text, p_nascimento text, p_pin text, p_cpf text DEFAULT NULL::text, p_filhos jsonb DEFAULT '[]'::jsonb, p_confianca jsonb DEFAULT NULL::jsonb, p_aparelho text DEFAULT NULL::text, p_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')); v_nasc date := public.app_data(p_nascimento);
  v_filhos jsonb := coalesce(p_filhos, '[]'::jsonb); v_f jsonb; v_fd date; v_cpf text := nullif(regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'), ''); v_fcpf text; v_i integer := 0;
  v_cpfs text[] := '{}'; v_r jsonb; v_pac uuid; v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if jsonb_typeof(v_filhos) <> 'array' or jsonb_array_length(v_filhos) > 10 then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Lista de filhos inválida (no máximo 10).'); end if;
  if v_cpf is not null and not public.fluxo_cpf_ok(v_cpf) then return jsonb_build_object('ok', false, 'erro', 'cpf', 'mensagem', 'Os números do seu CPF não conferem. Confira, por favor.'); end if;
  if v_cpf is null and v_tel ~ '^[1-9]{2}9[0-9]{8}$' and public.app_nome_ok(v_nome) and v_nasc is not null then v_cpf := public.app_cpf_historico(v_tel, v_nome, v_nasc, 'proprio'); end if;
  if v_cpf is null then return jsonb_build_object('ok', false, 'erro', 'cpf_falta', 'mensagem', 'Informe o seu CPF para criar o PIN.'); end if;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fd := public.app_data(v_f ->> 'nascimento'); v_fcpf := nullif(regexp_replace(coalesce(v_f ->> 'cpf', ''), '\D', '', 'g'), '');
    if v_fcpf is not null and not public.fluxo_cpf_ok(v_fcpf) then return jsonb_build_object('ok', false, 'erro', 'filho_cpf', 'indice', v_i, 'mensagem', 'Os números do CPF de ' || split_part(coalesce(v_f ->> 'nome', 'filho(a)'), ' ', 1) || ' não conferem.'); end if;
    if v_fcpf is null and v_fd is not null and public.app_nome_ok(v_f ->> 'nome') and v_tel ~ '^[1-9]{2}9[0-9]{8}$' then v_fcpf := public.app_cpf_historico(v_tel, v_f ->> 'nome', v_fd, 'filho'); end if;
    v_cpfs := array_append(v_cpfs, v_fcpf); v_i := v_i + 1;   -- CPF do filho é OPCIONAL (23/11/2026): sem ele fica em branco e o chat pede na hora de marcar
  end loop;
  v_r := public.app_cadastrar(p_telefone, p_nome, p_nascimento, p_pin, v_filhos, p_confianca, p_aparelho);
  if coalesce((v_r ->> 'ok')::boolean, false) is not true then return v_r; end if;
  select id into v_pac from public.app_paciente where telefone = v_tel;
  update public.app_paciente set cpf = v_cpf, atualizado_em = now(), email = case when v_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(v_email) <= 200 then v_email else email end where id = v_pac;
  v_i := 0;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_i := v_i + 1;
    update public.app_filho set cpf = v_cpfs[v_i]
     where responsavel_id = v_pac and removido_em is null and public.app_norm(nome) = public.app_norm(v_f ->> 'nome') and nascimento = public.app_data(v_f ->> 'nascimento');
  end loop;
  perform public.app_conferir_cadastro(v_pac);
  return jsonb_build_object('ok', true, 'token', v_r ->> 'token', 'perfil', public.app_perfil_json(v_pac));
end $function$;
