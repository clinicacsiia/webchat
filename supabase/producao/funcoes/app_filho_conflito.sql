-- public.app_filho_conflito(p_titular_nome text, p_titular_nasc date, p_nome text, p_nasc date, p_confirmado boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_filho_conflito(p_titular_nome text, p_titular_nasc date, p_nome text, p_nasc date, p_confirmado boolean)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case
    when public.app_norm(p_nome) is distinct from public.app_norm(p_titular_nome) then null
    when p_nasc = p_titular_nasc then jsonb_build_object('ok', false, 'erro', 'mesmo_cadastro', 'mensagem', 'Esse é o seu próprio cadastro: não precisa colocar você como filho(a).')
    when coalesce(p_confirmado, false) then null
    else jsonb_build_object('ok', false, 'erro', 'homonimo', 'mensagem', 'O nome é igual ao seu. Se for outra pessoa com o mesmo nome (por exemplo, um(a) filho(a)), confirme para continuar.')
  end $function$;

