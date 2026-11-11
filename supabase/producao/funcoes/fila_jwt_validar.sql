-- public.fila_jwt_validar(p_token text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_jwt_validar(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_segredo text;
  v_partes text[];
  v_esperada text;
  v_claims jsonb;
begin
  if p_token is null or length(p_token) > 2000 then return null; end if;
  v_partes := string_to_array(p_token, '.');
  if array_length(v_partes, 1) is distinct from 3 then return null; end if;
  v_segredo := public.fila_segredo_vault('fila_jwt_secret');
  if v_segredo is null then return null; end if;
  v_esperada := public.fila_b64url(
    extensions.hmac(convert_to(v_partes[1] || '.' || v_partes[2], 'UTF8'), convert_to(v_segredo, 'UTF8'), 'sha256'));
  if v_esperada is distinct from v_partes[3] then return null; end if;
  if convert_from(public.fila_b64url_decode(v_partes[1]), 'UTF8')::jsonb ->> 'alg' is distinct from 'HS256' then return null; end if;
  v_claims := convert_from(public.fila_b64url_decode(v_partes[2]), 'UTF8')::jsonb;
  if v_claims ->> 'aud' is distinct from 'fila' then return null; end if;
  if (v_claims ->> 'exp')::bigint <= floor(extract(epoch from now()))::bigint then return null; end if;
  if nullif(v_claims ->> 'atendimento_id', '')::uuid is null then return null; end if;
  return v_claims;
exception when others then
  return null;
end $function$;

