-- public.app_login(p_telefone text, p_pin text, p_aparelho text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_login(p_telefone text, p_pin text, p_aparelho text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_tel text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g'); a public.app_paciente%rowtype; v_seg integer; r jsonb; v_token text;
begin
  if not public.app_modo() then return public.app_erro_json('indisponivel'); end if;
  select * into a from public.app_paciente where telefone = v_tel for update;
  if not found then
    perform extensions.crypt(coalesce(p_pin, ''), extensions.gen_salt('bf', 8));
    return jsonb_build_object('ok', false, 'erro', 'login', 'mensagem', 'Celular ou PIN incorretos.');
  end if;
  v_seg := public.app_trava(a.id);
  if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
  if coalesce(p_pin, '') ~ '^[0-9]{4}$' and a.pin_hash = extensions.crypt(p_pin, a.pin_hash) then
    perform public.app_acerto(a.id);
    v_token := public.app_aparelho_abrir(a.id, p_aparelho);
    perform public.app_evento_gravar(a.id, 'login_aparelho_novo');
    return jsonb_build_object('ok', true, 'token', v_token, 'perfil', public.app_perfil_json(a.id));
  end if;
  r := public.app_falha(a.id);
  if r ->> 'erro' = 'bloqueado' then return r; end if;
  return jsonb_build_object('ok', false, 'erro', 'login', 'mensagem', 'Celular ou PIN incorretos.');
end $function$;

