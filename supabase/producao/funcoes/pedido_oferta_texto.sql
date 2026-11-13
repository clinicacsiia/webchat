-- public.pedido_oferta_texto(p_slot jsonb, p_n integer, p_original text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pedido_oferta_texto(p_slot jsonb, p_n integer, p_original text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  v_modelo text := case when p_n <= 1 then coalesce((select valor from public.config where chave = 'pedido_sem_horario_texto'), '')
                        else coalesce((select valor from public.config where chave = 'pedido_oferta2_texto'), '') end;
  v_data date := (p_slot ->> 'data')::date;
  v_oferta text;
begin
  v_oferta := v_dias[extract(dow from v_data)::int + 1] || ', ' || to_char(v_data, 'DD/MM') || ' às ' || left(p_slot ->> 'hora', 5)
              || coalesce(' na unidade ' || initcap(lower(nullif(p_slot ->> 'unidade', ''))), '');
  return replace(replace(v_modelo, '{original}', coalesce(p_original, 'o horário anterior')), '{oferta}', v_oferta);
end $function$
;
