-- public.ia_evento_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ia_evento_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_agente uuid := (select auth.uid());
  v_por text := 'sistema';
  v_ctx jsonb;
begin
  if v_agente is not null and exists (select 1 from public.agentes a where a.id = v_agente and a.ativo) then
    v_por := 'atendente';
  else
    v_agente := null;
  end if;

  select jsonb_build_object(
    'tipo', new.tipo, 'especialidade', new.especialidade, 'plano', new.plano, 'unidade', new.unidade, 'etapa', new.etapa,
    'exames', coalesce((select jsonb_agg(distinct coalesce(i.procedimento, i.regiao_nome)) from public.pre_agendamento_itens i
                         where i.conversa_id = new.conversa_id and i.ativo and coalesce(i.procedimento, i.regiao_nome) is not null),
                       case when new.procedimento is not null then jsonb_build_array(new.procedimento) else '[]'::jsonb end))
    into v_ctx;

  if tg_op = 'INSERT' then
    insert into public.ia_evento (pre_agendamento_id, conversa_id, tipo, para, por, agente_id, contexto)
    values (new.id, new.conversa_id, 'criado', new.status, v_por, v_agente, v_ctx);
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.ia_evento (pre_agendamento_id, conversa_id, tipo, de, para, por, agente_id, detalhe, contexto)
    values (new.id, new.conversa_id, 'status', old.status, new.status, v_por, v_agente,
            case when new.status = 'agendado' and new.agendado_auto_em is distinct from old.agendado_auto_em then 'automatico' end, v_ctx);
  end if;
  if new.conferencia_status is distinct from old.conferencia_status and new.conferencia_status is not null then
    insert into public.ia_evento (pre_agendamento_id, conversa_id, tipo, de, para, por, agente_id, detalhe, contexto)
    values (new.id, new.conversa_id, 'conferencia', old.conferencia_status, new.conferencia_status, v_por, v_agente,
            left(new.conferencia_detalhe, 300), v_ctx);
  end if;
  return new;
exception when others then
  raise warning 'ia_evento_trg: %', sqlerrm;
  return new;
end $function$;

