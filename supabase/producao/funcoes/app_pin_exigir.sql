-- public.app_pin_exigir()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.app_pin_exigir()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_h jsonb; v_path text; v_tok text; s record;
begin
  if coalesce((select valor from public.config where chave = 'app_pin_servidor'), 'nao') <> 'sim' then return; end if;
  if not public.app_modo() or coalesce((select valor from public.config where chave = 'app_pin_obrigatorio'), 'nao') <> 'sim' then return; end if;
  begin v_h := current_setting('request.headers', true)::jsonb; exception when others then v_h := null; end;
  if v_h is null then return; end if;   -- sem requisição HTTP (rotina do banco, teste interno): a regra é da porta
  begin if coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') = 'service_role' then return; end if; exception when others then null; end;
  begin v_path := current_setting('request.path', true); exception when others then v_path := null; end;
  if coalesce(v_path, '') like '/rpc/app\_%' then return; end if;   -- as funções app_* já conferem o aparelho e o PIN sozinhas
  v_tok := nullif(btrim(coalesce(v_h ->> 'x-acesso', '')), '');
  if v_tok is null then raise exception 'pin_obrigatorio' using hint = 'Digite o seu PIN para continuar.'; end if;
  select * into s from public.app_aparelho_validar(v_tok);   -- confere o PIN dos últimos 30 minutos e renova o prazo
  if s.o_erro is not null then raise exception 'pin_obrigatorio' using hint = 'Digite o seu PIN para continuar.'; end if;
end $function$;

