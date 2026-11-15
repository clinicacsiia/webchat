-- public.app_conta_antiga_migrar(p_pin text, p_telefone text, p_nome text, p_nascimento text, p_filhos jsonb, p_aparelho text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_conta_antiga_migrar(p_pin text, p_telefone text DEFAULT NULL::text, p_nome text DEFAULT NULL::text, p_nascimento text DEFAULT NULL::text, p_filhos jsonb DEFAULT NULL::jsonb, p_aparelho text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  cp public.contas_paciente%rowtype; p public.pacientes%rowtype; v_tel text; v_nome text; v_nasc date; v_cpf text; v_email text; v_id uuid; v_max integer; v_token text;
  v_filhos jsonb := coalesce(p_filhos, '[]'::jsonb); v_f jsonb; v_fn text; v_fd date; v_c jsonb; v_chave text; v_vistos text[] := '{}'; v_fcpf text;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  select * into cp from public.contas_paciente where id = (select auth.uid()) for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'sem_conta', 'mensagem', 'Entre com o e-mail e a senha da sua conta antiga.'); end if;
  if exists (select 1 from public.app_paciente where conta_antiga_id = cp.id) then
    return jsonb_build_object('ok', false, 'erro', 'ja_migrada', 'mensagem', 'Você já criou o seu PIN. Entre com o celular e o PIN.');
  end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  if cp.paciente_id is not null then select * into p from public.pacientes where id = cp.paciente_id; end if;

  v_tel := coalesce(public.app_tel_br(p_telefone), public.app_tel_br(cp.telefone), (select public.app_tel_br(x) from unnest(coalesce(p.telefones, '{}'::text[])) x where public.app_tel_br(x) is not null limit 1));
  v_nome := coalesce(nullif(btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g')), ''), nullif(btrim(cp.nome), ''), nullif(btrim(p.nome), ''));
  v_nasc := coalesce(public.app_data(p_nascimento), case when p.dt_nasc between date '1900-01-01' and public.app_hoje() then p.dt_nasc end);
  if v_tel is null then return jsonb_build_object('ok', false, 'erro', 'celular', 'mensagem', 'Informe o seu celular com DDD + 9 dígitos.'); end if;
  if not public.app_nome_ok(v_nome) then return jsonb_build_object('ok', false, 'erro', 'nome', 'mensagem', 'Digite nome e sobrenome completos.'); end if;
  if v_nasc is null or v_nasc > public.app_hoje() or v_nasc < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'nascimento', 'mensagem', 'Informe a data de nascimento.'); end if;
  if public.app_idade(v_nasc) < 18 then return jsonb_build_object('ok', false, 'erro', 'menor', 'mensagem', 'O cadastro principal precisa ser de um maior de 18 anos.'); end if;

  if jsonb_typeof(v_filhos) <> 'array' or jsonb_array_length(v_filhos) > 10 then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Lista de filhos inválida (no máximo 10).'); end if;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fn := btrim(regexp_replace(coalesce(v_f ->> 'nome', ''), '\s+', ' ', 'g')); v_fd := public.app_data(v_f ->> 'nascimento');
    if jsonb_typeof(v_f) <> 'object' or not public.app_nome_ok(v_fn) then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe nome e sobrenome do filho(a).'); end if;
    if v_fd is null or v_fd > public.app_hoje() or v_fd < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe a data de nascimento de ' || split_part(v_fn, ' ', 1) || '.'); end if;
    v_c := public.app_filho_conflito(v_nome, v_nasc, v_fn, v_fd, coalesce(v_f ->> 'mesmo_nome_confirmado', '') = 'true');
    if v_c is not null then return v_c; end if;
  end loop;

  select case when valor ~ '^[0-9]+$' then valor::int end into v_max from public.config where chave = 'app_cadastros_max_hora';
  if (select count(*) from public.app_paciente where criado_em > now() - interval '1 hour') >= coalesce(v_max, 100) then
    return jsonb_build_object('ok', false, 'erro', 'limite', 'mensagem', 'Muitos cadastros agora. Tente de novo em alguns minutos.');
  end if;
  if exists (select 1 from public.app_paciente where telefone = v_tel) then
    return jsonb_build_object('ok', false, 'erro', 'telefone_cadastrado', 'mensagem', 'Este celular já tem acesso rápido. Entre com o celular e o PIN, ou use outro celular.');
  end if;

  v_cpf := case when regexp_replace(coalesce(p.cpf, ''), '\D', '', 'g') ~ '^[0-9]{11}$' and public.fluxo_cpf_ok(regexp_replace(p.cpf, '\D', '', 'g')) then regexp_replace(p.cpf, '\D', '', 'g') end;
  v_email := case when lower(btrim(coalesce(cp.email, ''))) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then lower(btrim(cp.email)) end;
  begin
    insert into public.app_paciente (telefone, nome, nascimento, pin_hash, paciente_sugerido_id, cpf, email, conta_antiga_id)
    values (v_tel, v_nome, v_nasc, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), cp.paciente_id, v_cpf, v_email, cp.id) returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'erro', 'telefone_cadastrado', 'mensagem', 'Este celular já tem acesso rápido. Entre com o celular e o PIN, ou use outro celular.');
  end;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fn := btrim(regexp_replace(v_f ->> 'nome', '\s+', ' ', 'g')); v_fd := public.app_data(v_f ->> 'nascimento');
    v_chave := public.app_norm(v_fn) || '|' || v_fd::text;
    continue when v_chave = any(v_vistos);
    v_vistos := v_vistos || v_chave;
    select h.cpf into v_fcpf from public.app_conta_antiga_historico_filhos(cp.id) h where h.chave = public.app_norm(v_fn) and (h.nasc is null or h.nasc = v_fd) and h.cpf is not null limit 1;
    insert into public.app_filho (responsavel_id, nome, nascimento, cpf, criado_em) values (v_id, v_fn, v_fd, v_fcpf, clock_timestamp());
  end loop;
  v_token := public.app_aparelho_abrir(v_id, p_aparelho);
  perform public.app_evento_gravar(v_id, 'conta_antiga_herdada');
  return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(v_id));
end $function$;

