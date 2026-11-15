-- public.app_filho_remover(p_token text, p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_filho_remover(p_token text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  update public.app_filho set removido_em = now() where id = p_id and responsavel_id = s.o_pac and removido_em is null;
  if found then
    update public.app_marcacao set status = 'cancelada', atualizado_em = now() where filho_id = p_id and responsavel_id = s.o_pac and status = 'solicitada';
  end if;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $function$;

