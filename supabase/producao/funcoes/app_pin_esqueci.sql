-- public.app_pin_esqueci(p_telefone text, p_nome text, p_nascimento text, p_pin_novo text, p_aparelho text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_pin_esqueci(p_telefone text, p_nome text, p_nascimento text, p_pin_novo text, p_aparelho text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); a public.app_paciente%rowtype; v_seg integer; r jsonb; v_token text; v_cod public.app_codigo_email%rowtype;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if coalesce(p_pin_novo, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  if public.app_pin_fraco(p_pin_novo) then return jsonb_build_object('ok', false, 'erro', 'pin_fraco', 'mensagem', 'Escolha um PIN menos óbvio: não use números repetidos (1111), em sequência (1234) nem pares repetidos (1212).'); end if;
  if public.app_codigo_exigido() then   -- o código do e-mail (ou o que a atendente passou) precisa ter sido digitado e aceito
    select * into v_cod from public.app_codigo_email where telefone = v_tel and finalidade = 'esqueci_pin' and validado_em > now() - interval '30 minutes' and usado_em is null and descartado_em is null order by validado_em desc limit 1 for update;
    if not found then return jsonb_build_object('ok', false, 'erro', 'codigo_email', 'mensagem', 'Confirme o código enviado ao seu e-mail antes de criar um novo PIN.'); end if;
  end if;
  select * into a from public.app_paciente where telefone = v_tel for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'dados', 'mensagem', 'Os dados não conferem com o cadastro.'); end if;
  v_seg := public.app_trava(a.id);
  if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
  if public.app_norm(p_nome) = public.app_norm(a.nome) and public.app_data(p_nascimento) = a.nascimento then
    update public.app_paciente set pin_hash = extensions.crypt(p_pin_novo, extensions.gen_salt('bf', 8)), atualizado_em = now() where id = a.id;
    perform public.app_acerto(a.id);
    if v_cod.id is not null then update public.app_codigo_email set usado_em = now() where id = v_cod.id; end if;
    delete from public.app_aparelho where paciente_id = a.id;
    v_token := public.app_aparelho_abrir(a.id, p_aparelho);
    perform public.app_evento_gravar(a.id, 'pin_redefinido');
    return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(a.id));
  end if;
  r := public.app_falha(a.id);
  if r ->> 'erro' = 'bloqueado' then return r; end if;
  return jsonb_build_object('ok', false, 'erro', 'dados', 'restantes', r -> 'restantes', 'mensagem', 'Os dados não conferem com o cadastro.');
end $function$;

