-- public.pessoa_agrupar_conversa_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_agrupar_conversa_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  begin perform public.pessoa_agrupar(new.id); perform public.pessoa_unir_grupos(new.id); exception when others then null; end;
  begin perform public.paciente_klingo_ligar(new.id); exception when others then null; end;
  return null;
end $function$;

