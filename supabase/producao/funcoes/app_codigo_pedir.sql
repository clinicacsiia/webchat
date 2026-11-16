-- public.app_codigo_pedir(p_telefone text, p_finalidade text, p_email text, p_nome text, p_nascimento text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_codigo_pedir(p_telefone text, p_finalidade text, p_email text DEFAULT NULL::text, p_nome text DEFAULT NULL::text, p_nascimento text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); v_email text := lower(btrim(coalesce(p_email, ''))); v_nome text := btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  a public.app_paciente%rowtype; v_seg integer; v_min integer; v_id uuid; v_cod text; v_mask text; v_r jsonb;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if not public.app_codigo_exigido() then return jsonb_build_object('ok', true, 'exigido', false); end if;
  if p_finalidade not in ('cadastro', 'esqueci_pin') then return jsonb_build_object('ok', false, 'erro', 'finalidade', 'mensagem', 'Não foi possível concluir.'); end if;
  if v_tel !~ '^[1-9]{2}9[0-9]{8}$' then return jsonb_build_object('ok', false, 'erro', 'celular', 'mensagem', 'Celular inválido. Use DDD + 9 dígitos.'); end if;
  if p_finalidade = 'cadastro' then
    if exists (select 1 from public.app_paciente where telefone = v_tel) then return jsonb_build_object('ok', false, 'erro', 'telefone_cadastrado', 'mensagem', 'Este celular já tem cadastro. Entre com o seu PIN.'); end if;
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email) > 200 then return jsonb_build_object('ok', false, 'erro', 'email', 'mensagem', 'Digite um e-mail válido para receber o código.'); end if;
  else
    select * into a from public.app_paciente where telefone = v_tel for update;
    if not found then return jsonb_build_object('ok', false, 'erro', 'dados', 'mensagem', 'Os dados não conferem com o cadastro.'); end if;
    v_seg := public.app_trava(a.id);
    if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
    if not (public.app_norm(p_nome) = public.app_norm(a.nome) and public.app_data(p_nascimento) = a.nascimento) then
      v_r := public.app_falha(a.id);   -- conta nas mesmas tentativas do PIN (e bloqueia igual)
      if v_r ->> 'erro' = 'bloqueado' then return v_r; end if;
      return jsonb_build_object('ok', false, 'erro', 'dados', 'restantes', v_r -> 'restantes', 'mensagem', 'Os dados não conferem com o cadastro.');
    end if;
    v_email := lower(btrim(coalesce(a.email, ''))); v_nome := a.nome;
    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then v_email := ''; end if;
  end if;
  if (select count(*) from public.app_codigo_email where telefone = v_tel and finalidade = p_finalidade and criado_em > now() - interval '1 hour') >= 3 then
    return jsonb_build_object('ok', false, 'erro', 'muitos', 'mensagem', 'Você já pediu vários códigos. Espere um pouco ou fale com a clínica.');
  end if;
  if (select count(*) from public.app_codigo_email where criado_em > now() - interval '1 hour') >= 200 then
    return jsonb_build_object('ok', false, 'erro', 'limite', 'mensagem', 'Muitos pedidos agora. Tente de novo em alguns minutos.');
  end if;
  select case when valor ~ '^[0-9]+$' then valor::int end into v_min from public.config where chave = 'app_codigo_validade_min';
  v_min := least(greatest(coalesce(v_min, 60), 5), 720);
  -- depois de 3 dias o registro perde nome, e-mail, celular e código (sem "delete": o conector do Supabase pede confirmação do dono em comandos que apagam)
  update public.app_codigo_email set nome = null, email = null, telefone = '00000000000', codigo = '000000', descartado_em = coalesce(descartado_em, now()) where criado_em < now() - interval '3 days' and telefone <> '00000000000';
  update public.app_codigo_email set descartado_em = now() where telefone = v_tel and finalidade = p_finalidade and usado_em is null and descartado_em is null;
  v_cod := lpad((('x' || substr(md5(gen_random_uuid()::text), 1, 8))::bit(32)::bigint % 1000000)::text, 6, '0');
  insert into public.app_codigo_email (finalidade, telefone, nome, email, codigo, expira_em, envio)
  values (p_finalidade, v_tel, nullif(v_nome, ''), nullif(v_email, ''), v_cod, now() + make_interval(mins => v_min), case when v_email = '' then 'sem_email' else 'pendente' end) returning id into v_id;
  if v_email <> '' then
    perform public.app_codigo_disparar(v_id);
    v_mask := left(split_part(v_email, '@', 1), 1) || '***@' || split_part(v_email, '@', 2);
  end if;
  return jsonb_build_object('ok', true, 'exigido', true, 'enviado', v_email <> '', 'email_mascara', v_mask, 'validade_min', v_min);
end $function$;

