-- public.app_acesso_registrar(p_token text, p_evento text, p_local jsonb, p_dispositivo jsonb)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.app_acesso_registrar(p_token text, p_evento text, p_local jsonb DEFAULT NULL::jsonb, p_dispositivo jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if coalesce(p_evento, '') not in ('cadastro', 'login', 'desbloqueio', 'conta_antiga', 'pin_esqueci', 'abertura') then return jsonb_build_object('ok', false, 'erro', 'evento', 'mensagem', 'Não foi possível registrar.'); end if;
  return jsonb_build_object('ok', true) || public.app_acesso_gravar(s.o_pac, s.o_aparelho, p_evento, p_local, coalesce(p_dispositivo, '{}'::jsonb));
end $function$;

