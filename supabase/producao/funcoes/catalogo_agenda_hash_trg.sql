-- public.catalogo_agenda_hash_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.catalogo_agenda_hash_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  new.hash := coalesce(new.hash, md5(row(new.unidade, new.local, new.profissional_id, new.profissional, new.especialidade,
    new.procedimento_id, new.procedimento, new.dia_num, new.dia, new.hora_ini, new.hora_fim, new.duracao_min, new.operadoras,
    new.tele, new.vagas_extras, new.vig_ini, new.vig_fim)::text));
  return new;
end $function$;

