-- public.app_confianca_novo_codigo(p_token text, p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_confianca_novo_codigo(p_token text, p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  update public.app_contato_confianca set codigo = public.app_confianca_gerar_codigo(), codigo_falhas = 0
   where id = p_id and responsavel_id = s.o_pac and removido_em is null and vinculado_em is null;
  return jsonb_build_object('ok', true, 'perfil', public.app_perfil_json(s.o_pac));
end $function$;

