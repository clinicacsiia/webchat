-- public.pmarc_abrir(p_codigo text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.pmarc_abrir(p_codigo text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.pmarc_pessoa;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, ''));
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  update public.pmarc_pessoa set primeiro_acesso_em = coalesce(primeiro_acesso_em, now()), ultimo_acesso_em = now() where id = p.id;
  return public.pmarc_vista(p.id);
end $function$;

