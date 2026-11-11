-- public.conversa_fluxo_klingo_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.conversa_fluxo_klingo_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.dados -> 'digitado' ? 'cpf' and new.dados -> 'digitado' ? 'dt_nasc' then
    perform public.klingo_conferir_agendar(new.conversa_id);
  end if;
  return new;
exception when others then
  return new;
end $function$;

