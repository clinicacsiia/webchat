-- public.disponibilidade_converter_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_converter_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_procs integer[];
begin
  if new.status = 'agendado' and old.status is distinct from 'agendado' then
    select array_agg(i.procedimento_id) into v_procs from public.pre_agendamento_itens i where i.conversa_id = new.conversa_id and i.ativo and i.procedimento_id is not null;
    for r in select id from public.disponibilidade_pedido where (conversa_id = new.conversa_id or pre_agendamento_id = new.id) and estado in ('ativa', 'oportunidade_identificada', 'notificada', 'aguardando_resposta')
                and (v_procs is null or procedimentos && v_procs) loop
      update public.disponibilidade_pedido set agendamento_pre_id = new.id where id = r.id;
      perform public.disponibilidade_mudar_estado(r.id, 'convertida_em_agendamento', case when new.agendado_origem = 'chat_api' then 'api' else 'equipe' end, jsonb_build_object('origem', new.agendado_origem));
      update public.disponibilidade_oportunidade set estado = 'aceita' where pedido_id = r.id and estado in ('nova', 'notificada');
    end loop;
  end if;
  return new;
end $function$;

