-- public.pre_agendamento_vincula_conta_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pre_agendamento_vincula_conta_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.paciente_id is null or (tg_op = 'UPDATE' and new.paciente_id is not distinct from old.paciente_id) then return new; end if;
  update public.contas_paciente cp set paciente_id = new.paciente_id
    from public.conversas c, public.pacientes p
   where c.id = new.conversa_id and cp.id = c.conta_id and cp.paciente_id is null
     and c.paciente_tipo = 'proprio'
     and p.id = new.paciente_id and p.origem_conversa = new.conversa_id;
  return new;
end $function$;

