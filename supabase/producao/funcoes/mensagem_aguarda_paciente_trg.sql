-- public.mensagem_aguarda_paciente_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.mensagem_aguarda_paciente_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.autor = 'agente' and new.agente_id is not null then
    update public.conversas set aguarda_paciente_desde = now(), chamar_zap_em = null where id = new.conversa_id and status = 'em_atendimento';
  elsif new.autor = 'cliente' then
    update public.conversas set aguarda_paciente_desde = null, chamar_zap_em = null
     where id = new.conversa_id and (aguarda_paciente_desde is not null or chamar_zap_em is not null);
  end if;
  return new;
end $function$;

