-- public.permissao_modo_definir(p_modo text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.permissao_modo_definir(p_modo text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_antes text;
begin
  if coalesce((select public.papel_atual()), '') <> 'admin' then raise exception 'Apenas administradores.' using errcode = '42501'; end if;
  if p_modo not in ('desligado', 'observacao', 'ligado') then raise exception 'Modo inválido.' using errcode = '22023'; end if;
  select valor into v_antes from public.config where chave = 'permissao_modo';
  update public.config set valor = p_modo where chave = 'permissao_modo';
  insert into public.org_alteracao_log (por, acao, alvo, antes, depois) values ((select auth.uid()), 'permissao_modo', 'config', to_jsonb(v_antes), to_jsonb(p_modo));
  return p_modo;
end $function$;

