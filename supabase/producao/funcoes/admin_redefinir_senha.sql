-- public.admin_redefinir_senha(p_agente uuid, p_senha text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.admin_redefinir_senha(p_agente uuid, p_senha text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if (select public.papel_atual()) is distinct from 'admin' then
    raise exception 'Apenas administradores podem redefinir senhas.';
  end if;
  if p_senha is null or length(p_senha) < 8 then
    raise exception 'A senha precisa ter pelo menos 8 caracteres.';
  end if;
  if p_agente = auth.uid() then
    raise exception 'Para trocar a sua própria senha, use a opção Minha senha.';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_senha, extensions.gen_salt('bf')),
         raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || '{"trocar_senha": true}'::jsonb,
         updated_at = now()
   where id = p_agente;
  if not found then raise exception 'Pessoa não encontrada.'; end if;
end $function$;

