-- public.fila_jwt_assinar(p_claims jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_jwt_assinar(p_claims jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_segredo text := public.fila_segredo_vault('fila_jwt_secret');
  v_h text;
  v_p text;
begin
  if v_segredo is null then
    raise exception 'Segredo do token não configurado no Vault (fila_jwt_secret).' using errcode = 'P0001';
  end if;
  v_h := public.fila_b64url(convert_to('{"alg":"HS256","typ":"JWT"}', 'UTF8'));
  v_p := public.fila_b64url(convert_to(p_claims::text, 'UTF8'));
  return v_h || '.' || v_p || '.' ||
    public.fila_b64url(extensions.hmac(convert_to(v_h || '.' || v_p, 'UTF8'), convert_to(v_segredo, 'UTF8'), 'sha256'));
end $function$;

