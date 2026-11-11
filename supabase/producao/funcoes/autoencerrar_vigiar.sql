-- public.autoencerrar_vigiar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.autoencerrar_vigiar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_modo text; v_id uuid; v_eleg integer := 0; v_fech integer := 0; v_desde timestamptz; v_ok uuid; v_ag uuid;
begin
  select coalesce((select valor from public.config where chave = 'autoencerrar_modo'), 'desligado') into v_modo;
  if v_modo not in ('simulacao', 'ligado') then return jsonb_build_object('modo', 'desligado'); end if;
  if not pg_try_advisory_xact_lock(hashtext('autoencerrar_vigiar')) then return jsonb_build_object('modo', v_modo, 'ocupado', true); end if;
  for v_id in select * from public.autoencerrar_candidatas() loop
    v_eleg := v_eleg + 1;
    if v_modo = 'ligado' then
      select aguarda_paciente_desde, agente_id into v_desde, v_ag from public.conversas where id = v_id;
      update public.conversas set status = 'encerrada', ia_ativa = false, atualizado_em = now(),
             motivo_encerramento = 'nao_respondido', encerramento_origem = 'inatividade'
       where id = v_id and status = 'em_atendimento' and aguarda_paciente_desde is not null
         and aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())
       returning id into v_ok;
      if v_ok is not null then
        v_fech := v_fech + 1;
        insert into public.autoencerramento_fechada (conversa_id, aguarda_paciente_desde) values (v_id, v_desde) on conflict do nothing;
        insert into public.equipe_notificacao (agente_id, tipo, conversa_id, detalhe)
        values (v_ag, 'autoencerrada', v_id, jsonb_build_object('aviso', 'Conversa encerrada por falta de resposta do paciente.', 'horas', public.autoencerrar_horas()));
        v_ok := null;
      end if;
    end if;
  end loop;
  insert into public.autoencerramento_execucao (modo, elegiveis, fechadas) values (v_modo, v_eleg, v_fech);
  return jsonb_build_object('modo', v_modo, 'elegiveis', v_eleg, 'fechadas', v_fech);
end $function$;

