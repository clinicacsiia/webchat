-- public.klingo_sondagem_gravar(p_proc integer, p_tem boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_sondagem_gravar(p_proc integer, p_tem boolean)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ select public.klingo_sondagem_registrar(p_proc, p_tem, null) $function$;

