-- public.autoencerrar_vigiar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.autoencerrar_vigiar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_modo text; v_id uuid; v_eleg integer := 0; v_marc integer := 0; v_ok uuid; v_ag uuid;
begin
  select coalesce((select valor from public.config where chave = 'autoencerrar_modo'), 'desligado') into v_modo;
  if v_modo not in ('simulacao', 'ligado') then return jsonb_build_object('modo', 'desligado'); end if;
  if not pg_try_advisory_xact_lock(hashtext('autoencerrar_vigiar')) then return jsonb_build_object('modo', v_modo, 'ocupado', true); end if;
  for v_id in select * from public.autoencerrar_candidatas() loop
    v_eleg := v_eleg + 1;
    if v_modo = 'ligado' then
      update public.conversas set chamar_zap_em = now()
       where id = v_id and status = 'em_atendimento' and chamar_zap_em is null and aguarda_paciente_desde is not null
         and aguarda_paciente_desde <= now() - make_interval(hours => public.autoencerrar_horas())
       returning id, agente_id into v_ok, v_ag;
      if v_ok is not null then
        v_marc := v_marc + 1;
        insert into public.equipe_notificacao (agente_id, tipo, conversa_id, detalhe)
        values (v_ag, 'chamar_zap', v_id, jsonb_build_object('aviso', 'Paciente sem resposta há mais de 24 h: chame no WhatsApp e peça para responder no site.', 'horas', public.autoencerrar_horas()));
        v_ok := null;
      end if;
    end if;
  end loop;
  insert into public.autoencerramento_execucao (modo, elegiveis, fechadas) values (v_modo, v_eleg, v_marc);
  return jsonb_build_object('modo', v_modo, 'elegiveis', v_eleg, 'marcadas', v_marc, 'fechadas', 0);
end $function$;

