-- public.ind_imutavel_trg()
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.ind_imutavel_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  raise exception 'Dia fechado dos indicadores não pode ser alterado nem apagado.' using errcode = '42501';
end $function$;

