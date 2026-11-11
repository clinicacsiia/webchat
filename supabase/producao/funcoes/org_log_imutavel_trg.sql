-- public.org_log_imutavel_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.org_log_imutavel_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin raise exception 'O registro de alterações não pode ser alterado nem apagado.' using errcode = '42501'; end $function$;

