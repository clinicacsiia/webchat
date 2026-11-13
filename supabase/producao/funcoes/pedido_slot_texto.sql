-- public.pedido_slot_texto(p_slot jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pedido_slot_texto(p_slot jsonb)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select (array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'])[extract(dow from (p_slot ->> 'data')::date)::int + 1]
         || ', ' || to_char((p_slot ->> 'data')::date, 'DD/MM') || ' às ' || left(p_slot ->> 'hora', 5)
         || coalesce(' na unidade ' || initcap(lower(nullif(p_slot ->> 'unidade', ''))), '')
$function$
;
