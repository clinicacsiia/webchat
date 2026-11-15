-- public.app_cadastrar(p_telefone text, p_nome text, p_nascimento text, p_pin text, p_filhos jsonb, p_confianca jsonb, p_aparelho text)
-- Pode executar: anon, authenticated
CREATE OR REPLACE FUNCTION public.app_cadastrar(p_telefone text, p_nome text, p_nascimento text, p_pin text, p_filhos jsonb DEFAULT '[]'::jsonb, p_confianca jsonb DEFAULT NULL::jsonb, p_aparelho text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_nasc date := public.app_data(p_nascimento);
  v_filhos jsonb := coalesce(p_filhos, '[]'::jsonb);
  v_f jsonb; v_fd date; v_id uuid; v_sug uuid; v_max integer; v_ctel text; v_token text;
  v_c jsonb; v_vistos text[] := '{}'; v_chave text;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if v_tel !~ '^[1-9]{2}9[0-9]{8}$' then return jsonb_build_object('ok', false, 'erro', 'celular', 'mensagem', 'Celular inválido. Use DDD + 9 dígitos.'); end if;
  if not public.app_nome_ok(v_nome) then return jsonb_build_object('ok', false, 'erro', 'nome', 'mensagem', 'Digite nome e sobrenome completos.'); end if;
  if v_nasc is null or v_nasc > public.app_hoje() or v_nasc < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'nascimento', 'mensagem', 'Data de nascimento inválida.'); end if;
  if public.app_idade(v_nasc) < 18 then return jsonb_build_object('ok', false, 'erro', 'menor', 'mensagem', 'O cadastro principal precisa ser de um maior de 18 anos.'); end if;
  if coalesce(p_pin, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  if jsonb_typeof(v_filhos) <> 'array' or jsonb_array_length(v_filhos) > 10 then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Lista de filhos inválida (no máximo 10).'); end if;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_fd := public.app_data(v_f ->> 'nascimento');
    if jsonb_typeof(v_f) <> 'object' or not public.app_nome_ok(v_f ->> 'nome') then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Informe nome e sobrenome do filho(a).'); end if;
    if v_fd is null or v_fd > public.app_hoje() or v_fd < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', 'filho', 'mensagem', 'Data de nascimento do filho(a) inválida.'); end if;
    v_c := public.app_filho_conflito(v_nome, v_nasc, v_f ->> 'nome', v_fd, coalesce(v_f ->> 'mesmo_nome_confirmado', '') = 'true');   -- filho com o nome do titular: é ela mesma ou precisa de confirmação
    if v_c is not null then return v_c; end if;
  end loop;
  if p_confianca is not null and p_confianca <> 'null'::jsonb then
    v_ctel := regexp_replace(coalesce(p_confianca ->> 'telefone', ''), '\D', '', 'g');
    if jsonb_typeof(p_confianca) <> 'object' or length(btrim(coalesce(p_confianca ->> 'nome', ''))) < 2 or v_ctel !~ '^[1-9]{2}9[0-9]{8}$'
       or coalesce(p_confianca ->> 'relacao', '') not in ('Cônjuge', 'Pai/Mãe', 'Avó/Avô', 'Irmão(ã)', 'Outro') then
      return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Dados do número de confiança inválidos.');
    end if;
    if v_ctel = v_tel then return jsonb_build_object('ok', false, 'erro', 'confianca', 'mensagem', 'Use um número diferente do seu.'); end if;
  end if;
  select case when valor ~ '^[0-9]+$' then valor::int end into v_max from public.config where chave = 'app_cadastros_max_hora';
  if (select count(*) from public.app_paciente where criado_em > now() - interval '1 hour') >= coalesce(v_max, 100) then
    return jsonb_build_object('ok', false, 'erro', 'limite', 'mensagem', 'Muitos cadastros agora. Tente de novo em alguns minutos.');
  end if;
  if exists (select 1 from public.app_paciente where telefone = v_tel) then
    return jsonb_build_object('ok', false, 'erro', 'telefone_cadastrado', 'mensagem', 'Este celular já tem cadastro. Entre com o seu PIN.');
  end if;
  begin
    select (array_agg(p.id))[1] into v_sug from public.pacientes p
     where p.dt_nasc = v_nasc and p.telefones && array[v_tel, '55' || v_tel] and public.app_norm(p.nome) = public.app_norm(v_nome) having count(*) = 1;
  exception when others then v_sug := null;
  end;
  begin
    insert into public.app_paciente (telefone, nome, nascimento, pin_hash, paciente_sugerido_id)
    values (v_tel, v_nome, v_nasc, extensions.crypt(p_pin, extensions.gen_salt('bf', 8)), v_sug) returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'erro', 'telefone_cadastrado', 'mensagem', 'Este celular já tem cadastro. Entre com o seu PIN.');
  end;
  for v_f in select * from jsonb_array_elements(v_filhos) loop
    v_chave := public.app_norm(v_f ->> 'nome') || '|' || (v_f ->> 'nascimento');
    continue when v_chave = any(v_vistos);   -- o mesmo filho digitado duas vezes vale uma vez só
    v_vistos := v_vistos || v_chave;
    insert into public.app_filho (responsavel_id, nome, nascimento, criado_em)   -- clock_timestamp: a ordem digitada é a ordem mostrada
    values (v_id, btrim(regexp_replace(v_f ->> 'nome', '\s+', ' ', 'g')), public.app_data(v_f ->> 'nascimento'), clock_timestamp());
  end loop;
  if v_ctel is not null then
    insert into public.app_contato_confianca (responsavel_id, nome, telefone, relacao, codigo)
    values (v_id, btrim(p_confianca ->> 'nome'), v_ctel, p_confianca ->> 'relacao', public.app_confianca_gerar_codigo());
  end if;
  v_token := public.app_aparelho_abrir(v_id, p_aparelho);
  perform public.app_evento_gravar(v_id, 'cadastro');
  return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(v_id));
end $function$;

