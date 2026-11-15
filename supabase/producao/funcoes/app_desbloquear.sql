-- public.app_desbloquear(p_token text, p_pin text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_desbloquear(p_token text, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; a public.app_paciente%rowtype; v_seg integer;
begin
  select * into s from public.app_aparelho_validar(p_token, false);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into a from public.app_paciente where id = s.o_pac for update;
  v_seg := public.app_trava(a.id);
  if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
  if coalesce(p_pin, '') ~ '^[0-9]{4}$' and a.pin_hash = extensions.crypt(p_pin, a.pin_hash) then
    perform public.app_acerto(a.id);
    update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes' where id = s.o_aparelho;
    update public.app_paciente set ultimo_acesso_em = now() where id = a.id;
    return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(a.id));
  end if;
  return public.app_falha(a.id);
end $function$;

