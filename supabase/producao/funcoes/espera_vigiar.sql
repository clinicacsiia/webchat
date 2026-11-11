-- public.espera_vigiar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.espera_vigiar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; v_url text; v_seg text; v_dentro boolean := public.horario_trabalho_agora(); v_alertadas int := 0; v_avisadas int := 0; v_erro text;
begin
  begin
    if v_dentro then
      with alvo as (
        update public.conversas c set espera_alerta_em = now()
        where c.status <> 'encerrada' and not c.ia_ativa and c.cliente_aguarda_desde is not null
          and c.cliente_aguarda_desde <= now() - interval '10 minutes'
          and (c.espera_alerta_em is null or c.espera_alerta_em < c.cliente_aguarda_desde or c.espera_alerta_em <= now() - interval '15 minutes')
        returning c.id)
      select count(*) into v_alertadas from alvo;
      if v_alertadas > 0 then
        select valor into v_url from public.config where chave = 'equipe_push_url';
        v_seg := public.fila_aviso_segredo();
        if coalesce(v_url, '') <> '' and coalesce(v_seg, '') <> '' then
          perform net.http_post(url := v_url, body := jsonb_build_object('tipo', 'espera', 'quantidade', v_alertadas),
                                headers := jsonb_build_object('Content-Type', 'application/json', 'x-fila-aviso-segredo', v_seg));
        end if;
      end if;
    end if;
  exception when others then
    v_erro := 'alerta: ' || sqlerrm;
  end;
  begin
    for r in
      update public.conversas c set espera_aviso_paciente_em = now()
      where c.status <> 'encerrada' and not c.ia_ativa and c.cliente_aguarda_desde is not null
        and c.cliente_aguarda_desde <= now() - interval '20 minutes'
        and (c.espera_aviso_paciente_em is null or c.espera_aviso_paciente_em < c.cliente_aguarda_desde)
      returning c.id
    loop
      perform public.fluxo_dizer(r.id, public.fluxo_t(case when v_dentro then 'espera_longa_dentro' else 'espera_longa_fora' end, public.fluxo_ctx(r.id)));
      v_avisadas := v_avisadas + 1;
    end loop;
  exception when others then
    v_erro := coalesce(v_erro || '; ', '') || 'aviso: ' || sqlerrm;
  end;
  return jsonb_build_object('alertadas', v_alertadas, 'avisadas', v_avisadas, 'dentro_do_horario', v_dentro, 'erro', v_erro);
end $function$;

