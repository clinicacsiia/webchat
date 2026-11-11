-- public.chat_corpo_atualizar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.chat_corpo_atualizar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v jsonb; v_ini timestamptz := clock_timestamp();
begin
  v := public.chat_corpo_calcular();
  insert into public.chat_cache (chave, valor, calculado_em) values ('corpo', v, now())
  on conflict (chave) do update set valor = excluded.valor, calculado_em = excluded.calculado_em;
  return jsonb_build_object('ok', true, 'ms', round(extract(epoch from clock_timestamp() - v_ini) * 1000));
end $function$;

