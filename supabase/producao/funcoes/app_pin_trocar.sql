-- public.app_pin_trocar(p_token text, p_atual text, p_novo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_pin_trocar(p_token text, p_atual text, p_novo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; a public.app_paciente%rowtype; v_seg integer;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if coalesce(p_novo, '') !~ '^[0-9]{4}$' then return jsonb_build_object('ok', false, 'erro', 'pin', 'mensagem', 'O PIN precisa ter 4 números.'); end if;
  select * into a from public.app_paciente where id = s.o_pac for update;
  v_seg := public.app_trava(a.id);
  if v_seg > 0 then return public.app_bloqueado_json(v_seg); end if;
  if coalesce(p_atual, '') ~ '^[0-9]{4}$' and a.pin_hash = extensions.crypt(p_atual, a.pin_hash) then
    update public.app_paciente set pin_hash = extensions.crypt(p_novo, extensions.gen_salt('bf', 8)), atualizado_em = now() where id = a.id;
    perform public.app_acerto(a.id);
    perform public.app_evento_gravar(a.id, 'pin_trocado');
    return jsonb_build_object('ok', true);
  end if;
  return public.app_falha(a.id);
end $function$;

