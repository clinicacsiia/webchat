-- public.app_pin_esqueci(p_telefone text, p_nome text, p_nascimento text, p_pin_novo text, p_aparelho text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_pin_esqueci(p_telefone text, p_nome text, p_nascimento text, p_pin_novo text, p_aparelho text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); a public.app_paciente%rowtype; v_seg integer; r jsonb; v_token text;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  if coalesce(p_pin_novo, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  select * into a from public.app_paciente where telefone = v_tel for update;
  if not found then return jsonb_build_object('ok', false, 'erro', 'dados', 'mensagem', 'Os dados não conferem com o cadastro.'); end if;
  v_seg := public.app_trava(a.id);
  if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
  if public.app_norm(p_nome) = public.app_norm(a.nome) and public.app_data(p_nascimento) = a.nascimento then
    update public.app_paciente set pin_hash = extensions.crypt(p_pin_novo, extensions.gen_salt('bf', 8)), atualizado_em = now() where id = a.id;
    perform public.app_acerto(a.id);
    delete from public.app_aparelho where paciente_id = a.id;
    v_token := public.app_aparelho_abrir(a.id, p_aparelho);
    perform public.app_evento_gravar(a.id, 'pin_redefinido');
    return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(a.id));
  end if;
  r := public.app_falha(a.id);
  if r ->> 'erro' = 'bloqueado' then return r; end if;
  return jsonb_build_object('ok', false, 'erro', 'dados', 'restantes', r -> 'restantes', 'mensagem', 'Os dados não conferem com o cadastro.');
end $function$;

