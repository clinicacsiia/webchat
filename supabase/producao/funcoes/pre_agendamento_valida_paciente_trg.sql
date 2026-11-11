-- public.pre_agendamento_valida_paciente_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pre_agendamento_valida_paciente_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.status = 'agendado' and old.status is distinct from 'agendado' and new.paciente_id is not null then
    update public.pacientes set validado = true, validado_em = coalesce(validado_em, now()), atualizado_em = now() where id = new.paciente_id;
  end if;
  return new;
end $function$;

