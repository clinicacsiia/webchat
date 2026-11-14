-- public.klingo_saude_gravar(p_tipo text, p_ok boolean, p_ms integer, p_detalhe text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_saude_gravar(p_tipo text, p_ok boolean, p_ms integer, p_detalhe text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.klingo_saude (tipo, ok, ms, detalhe, em) values (left(p_tipo, 20), p_ok, p_ms, left(p_detalhe, 80), now())
  on conflict (tipo) do update set ok = excluded.ok, ms = excluded.ms, detalhe = excluded.detalhe, em = now()
$function$;

