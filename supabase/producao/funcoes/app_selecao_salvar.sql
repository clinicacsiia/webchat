-- public.app_selecao_salvar(p_token text, p_selecao jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_selecao_salvar(p_token text, p_selecao jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s record;
begin
  select * into s from public.app_aparelho_validar(p_token);
  if s.o_erro is not null then return public.app_erro_json(s.o_erro); end if;
  if jsonb_typeof(coalesce(p_selecao, 'null'::jsonb)) <> 'array' or jsonb_array_length(p_selecao) not between 1 and 11
     or exists (select 1 from jsonb_array_elements(p_selecao) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^(eu|[0-9a-f-]{36})$') then
    return jsonb_build_object('ok', false, 'erro', 'selecao', 'mensagem', 'Seleção inválida.');
  end if;
  update public.app_paciente set ultima_selecao = p_selecao where id = s.o_pac;
  return jsonb_build_object('ok', true);
end $function$;

