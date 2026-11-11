-- public.pessoa_agrupar_pre_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pessoa_agrupar_pre_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if tg_op = 'INSERT' or (new.paciente ->> 'dt_nasc') is distinct from (old.paciente ->> 'dt_nasc') or (new.paciente ->> 'nome') is distinct from (old.paciente ->> 'nome') then
    begin perform public.pessoa_agrupar(new.conversa_id); perform public.pessoa_unir_grupos(new.conversa_id); exception when others then null; end;
    begin perform public.paciente_klingo_ligar(new.conversa_id); exception when others then null; end;
  end if;
  if tg_op = 'INSERT' or (new.paciente ->> 'cpf', new.paciente ->> 'email', new.paciente ->> 'celular', new.paciente ->> 'dt_nasc') is distinct from (old.paciente ->> 'cpf', old.paciente ->> 'email', old.paciente ->> 'celular', old.paciente ->> 'dt_nasc') then
    begin perform public.paciente_dado_conferir(new.conversa_id); exception when others then null; end;
  end if;
  return null;
end $function$;

