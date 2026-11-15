-- public.app_pendencias(p_token text)
-- Pode executar: anon, authenticated
CREATE OR REPLACE FUNCTION public.app_pendencias(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record; a public.app_paciente%rowtype;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  select * into a from public.app_paciente where id = s.o_pac;
  if a.cpf is not null and (a.cadastro_conferido_em is null or a.cadastro_conferido_em < a.atualizado_em) then perform public.app_conferir_cadastro(a.id); end if;
  return jsonb_build_object('ok', true, 'pendencias', public.app_pendencias_lista(s.o_pac));
end $function$;

