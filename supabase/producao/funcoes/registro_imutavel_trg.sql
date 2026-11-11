-- public.registro_imutavel_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.registro_imutavel_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  raise exception 'Tabela % é imutável: não aceita alteração nem exclusão.', tg_table_name using errcode = 'P0001';
end $function$;

