-- public.app_falha(p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_falha(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_falhas integer; v_seg integer;
begin
  update public.app_paciente set pin_falhas = pin_falhas + 1 where id = p_id returning pin_falhas into v_falhas;
  if v_falhas is null then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'PIN incorreto.'); end if;
  if v_falhas % 5 = 0 then
    v_seg := case when v_falhas <= 5 then 60 when v_falhas <= 10 then 900 else 3600 end;
    update public.app_paciente set pin_bloqueado_ate = now() + make_interval(secs => v_seg) where id = p_id;
    perform public.app_evento_gravar(p_id, 'bloqueio');
    return public.app_bloqueado_json(v_seg);
  end if;
  return jsonb_build_object('ok', false, 'erro', 'pin', 'restantes', 5 - (v_falhas % 5),
    'mensagem', case when 5 - (v_falhas % 5) = 1 then 'PIN incorreto. Resta 1 tentativa.' else 'PIN incorreto. Restam ' || (5 - (v_falhas % 5)) || ' tentativas.' end);
end $function$;

