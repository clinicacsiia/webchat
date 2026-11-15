-- public.app_pin_token()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_pin_token()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_h jsonb; v_path text;
begin
  if coalesce((select valor from public.config where chave = 'app_pin_servidor'), 'nao') <> 'sim' then return null; end if;
  if not public.app_modo() or coalesce((select valor from public.config where chave = 'app_pin_obrigatorio'), 'nao') <> 'sim' then return null; end if;
  begin v_h := current_setting('request.headers', true)::jsonb; exception when others then v_h := null; end;
  if v_h is null then return null; end if;   -- sem requisição HTTP (rotina do banco, teste interno): a regra é da porta
  begin if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role' then return null; end if; exception when others then null; end;
  begin v_path := current_setting('request.path', true); exception when others then v_path := null; end;
  if coalesce(v_path, '') like '/rpc/app\_%' then return null; end if;   -- as funções app_* já conferem o aparelho e o PIN sozinhas
  if public.papel_atual() is not null then return null; end if;   -- a equipe (admin, atendente...) não usa PIN de paciente
  return coalesce(nullif(btrim(coalesce(v_h ->> 'x-acesso', '')), ''), '');
end $function$;

