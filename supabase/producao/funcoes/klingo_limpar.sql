-- public.klingo_limpar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_limpar()
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  delete from public.klingo_oferta where expira_em < now() - interval '1 day';
  delete from public.klingo_medida where dia < (now() at time zone 'America/Bahia')::date - 90;
  delete from public.klingo_evento where recebido_em < now() - interval '30 days';
  delete from public.klingo_conversa_ident where em < now() - interval '30 days';
$function$;

