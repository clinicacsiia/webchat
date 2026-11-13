-- public.agenda_conferencia_aplicar(p_resultados jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agenda_conferencia_aplicar(p_resultados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  e jsonb; s jsonb; it jsonb; pa public.pre_agendamentos;
  v_total int; v_ok int; v_outro int; v_passou boolean; v_div text; v_via text; v_ini timestamp;
  v_conf text; v_det text; v_alerta text; v_falhas int;
  v_agora timestamp := now() at time zone 'America/Bahia';
  v_confirmados int := 0; v_alertas int := 0; v_req int;
begin
  if p_resultados is not null and jsonb_typeof(p_resultados) = 'array' then
    for e in select x from jsonb_array_elements(p_resultados) x loop
      begin
        select * into pa from public.pre_agendamentos where id = nullif(e ->> 'id', '')::uuid for update skip locked;
        if not found or jsonb_typeof(pa.escolha_horario) <> 'array' then continue; end if;
        v_total := 0; v_ok := 0; v_outro := 0; v_passou := false;
        for s in select x from jsonb_array_elements(case when jsonb_typeof(e -> 'slots') = 'array' then e -> 'slots' else '[]'::jsonb end) x loop
          it := pa.escolha_horario -> (s ->> 'idx')::int;
          if it is null then continue; end if;
          v_total := v_total + 1;
          if s ->> 'r' = 'ok' then
            v_ok := v_ok + 1;
          else
            if s ->> 'r' = 'outro' then v_outro := v_outro + 1; end if;
            v_ini := case when coalesce((it ->> 'chegada')::boolean, false) then ((it ->> 'data')::date + 1)::timestamp
                          else (it ->> 'data')::date + (it ->> 'hora')::time + make_interval(mins => coalesce((it ->> 'min')::int, 30) + 60) end;
            if v_ini < v_agora then v_passou := true; end if;
          end if;
        end loop;
        if v_total = 0 then continue; end if;
        v_req := null;
        begin
          if not exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = pa.conversa_id and i.ativo and i.procedimento_id is null) then
            select jsonb_array_length(public.agenda_grupos(array_agg(i.procedimento_id order by i.id))) into v_req
            from public.pre_agendamento_itens i, lateral generate_series(1, i.quantidade) g
            where i.conversa_id = pa.conversa_id and i.ativo and i.procedimento_id is not null;
          end if;
        exception when others then v_req := null;
        end;
        if v_req is not null and v_total < v_req then continue; end if;
        v_div := left(nullif(btrim(coalesce(e ->> 'div', '')), ''), 300);
        v_via := case when e ->> 'via' in ('telefone','nome','ambos') then e ->> 'via' end;
        v_conf := null; v_det := null; v_alerta := null; v_falhas := 0;

        if v_ok = v_total then
          v_conf := 'confirmado';
        elsif pa.status = 'agendado' then
          if v_passou then continue; end if;
          if v_div is not null then
            v_conf := 'remarcado'; v_det := v_div; v_alerta := 'Marcação remarcada no Klingo';
          elsif coalesce(pa.conferencia_falhas, 0) + 1 >= 2 then
            v_conf := 'sumiu'; v_falhas := 2; v_alerta := 'Marcação sumiu do Klingo';
            v_det := 'A marcação deixou de aparecer na agenda do Klingo (cancelada ou remarcada?). Confira com o paciente.';
          else
            update public.pre_agendamentos set conferencia_falhas = coalesce(conferencia_falhas, 0) + 1 where id = pa.id;
            continue;
          end if;
        else
          if v_div is not null then
            v_conf := 'divergente'; v_det := v_div; v_alerta := 'Marcação diferente do que foi escolhido';
          elsif v_outro > 0 then
            v_conf := 'horario_tomado'; v_alerta := 'Horário ocupado no Klingo';
            v_det := 'O horário escolhido foi ocupado no Klingo por uma marcação que não bate com este paciente (outro nome ou telefone?). Confira ou ofereça outro horário.';
          elsif v_passou then
            v_conf := 'nao_encontrado'; v_alerta := 'Marcação não apareceu no Klingo';
            v_det := 'O horário escolhido já passou e nenhuma marcação deste paciente apareceu no Klingo.';
          end if;
        end if;

        if v_conf = 'confirmado' then
          if pa.status in ('rascunho','pronto') then
            update public.pre_agendamentos set status = 'agendado', conferencia_status = 'confirmado', conferencia_detalhe = null, conferencia_via = v_via,
              conferencia_em = now(), conferencia_falhas = 0, agendado_auto_em = now(), atualizado_em = now() where id = pa.id;
            perform public.pre_enviar_confirmacao(pa.id);
            v_confirmados := v_confirmados + 1;
          elsif pa.conferencia_status is distinct from 'confirmado' or coalesce(pa.conferencia_falhas, 0) <> 0 then
            update public.pre_agendamentos set conferencia_status = 'confirmado', conferencia_detalhe = null, conferencia_em = now(), conferencia_falhas = 0 where id = pa.id;
          end if;
        elsif pa.conferencia_status is distinct from v_conf or pa.conferencia_detalhe is distinct from v_det then
          update public.pre_agendamentos set conferencia_status = v_conf, conferencia_detalhe = v_det, conferencia_em = now(), conferencia_falhas = v_falhas where id = pa.id;
        end if;
        if v_alerta is not null then v_alertas := v_alertas + 1; end if;
        update public.conversas set alerta_agenda = v_alerta, atualizado_em = now() where id = pa.conversa_id and alerta_agenda is distinct from v_alerta and not (v_alerta is null and alerta_agenda like 'Pedido parado%');
      exception when others then
        raise warning 'agenda_conferencia_aplicar: % (%)', sqlerrm, e ->> 'id';
      end;
    end loop;
  end if;
  update public.agenda_ocupacao_meta set conferindo_ate = null where id = 1;
  return jsonb_build_object('confirmados', v_confirmados, 'alertas', v_alertas);
end $function$;

