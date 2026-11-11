-- public.chat_corpo(p_conversa uuid, p_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_corpo(p_conversa uuid, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb;
begin
  perform public.chat_valida(p_conversa, p_token);
  select valor into r from public.chat_cache where chave = 'corpo' and calculado_em > now() - interval '1 hour';
  if r is null then r := public.chat_corpo_calcular(); end if;
  return r;
end $function$;

