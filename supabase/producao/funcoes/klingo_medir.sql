-- public.klingo_medir(p_tipo text, p_n bigint, p_ms bigint)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_medir(p_tipo text, p_n bigint DEFAULT 1, p_ms bigint DEFAULT NULL::bigint)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.klingo_medida (dia, tipo, n, soma_ms) values ((now() at time zone 'America/Bahia')::date, left(p_tipo, 60), p_n, coalesce(p_ms, 0))
  on conflict (dia, tipo) do update set n = public.klingo_medida.n + excluded.n, soma_ms = public.klingo_medida.soma_ms + excluded.soma_ms
$function$;

