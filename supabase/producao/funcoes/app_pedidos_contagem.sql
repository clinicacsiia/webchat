-- public.app_pedidos_contagem(p_token text)
-- Pode executar: anon, authenticated
CREATE OR REPLACE FUNCTION public.app_pedidos_contagem(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb;
begin
  r := public.app_pedidos(p_token, false);
  if (r ->> 'ok')::boolean is not true then return r; end if;
  return jsonb_build_object('ok', true, 'novidades', (r ->> 'novidades')::int);
end $function$;

