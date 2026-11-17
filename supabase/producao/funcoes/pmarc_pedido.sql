-- public.pmarc_pedido(p_codigo text, p_dados jsonb)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.pmarc_pedido(p_codigo text, p_dados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  p public.pmarc_pessoa; d jsonb := case when jsonb_typeof(p_dados) = 'object' then p_dados else '{}'::jsonb end;
  v_pid integer; v_nome text; v_txt text; v_turno text; v_apos text; v_ate text; v_dia date; v_unid text; v_obs text; v_plano text; v_h jsonb; v_hdata date; v_hhora text; v_msg text; v_ped jsonb; v_conv uuid; v_lista jsonb;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  if (select count(*) from jsonb_array_elements(coalesce(p.informado -> 'pedidos', '[]'::jsonb)) e where (e ->> 'em')::timestamptz > now() - interval '1 hour') >= 10 then
    return jsonb_build_object('ok', false, 'motivo', 'muitos');
  end if;
  begin v_pid := nullif(d ->> 'procedimento_id', '')::integer; exception when others then v_pid := null; end;
  if v_pid is not null then select nome into v_nome from public.catalogo_procedimento where id = v_pid; if v_nome is null then v_pid := null; end if; end if;
  v_txt := nullif(left(btrim(coalesce(d ->> 'procedimento_texto', '')), 200), '');
  v_turno := case when d ->> 'turno' in ('manha', 'tarde', 'noite') then d ->> 'turno' end;
  v_apos := case when coalesce(d ->> 'hora_apos', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then d ->> 'hora_apos' end;
  v_ate := case when coalesce(d ->> 'hora_ate', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then d ->> 'hora_ate' end;
  begin v_dia := nullif(d ->> 'data_ate', '')::date; exception when others then v_dia := null; end;
  v_unid := nullif(left(btrim(coalesce(d ->> 'unidade', '')), 40), '');
  v_obs := nullif(left(btrim(coalesce(d ->> 'observacao', '')), 1000), '');
  v_plano := nullif(left(btrim(coalesce(d ->> 'plano', '')), 80), '');
  v_h := case when jsonb_typeof(d -> 'horario') = 'object' then d -> 'horario' end;
  if v_h is not null then
    begin v_hdata := (v_h ->> 'data')::date; exception when others then v_hdata := null; end;
    v_hhora := case when coalesce(v_h ->> 'hora', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then v_h ->> 'hora' end;
    if v_hdata is null or v_hhora is null then v_h := null; end if;
  end if;

  v_ped := jsonb_strip_nulls(jsonb_build_object('em', now(), 'procedimento_id', v_pid, 'procedimento', coalesce(v_nome, v_txt), 'turno', v_turno, 'hora_apos', v_apos, 'hora_ate', v_ate,
    'data_ate', v_dia, 'unidade', v_unid, 'observacao', v_obs, 'plano', v_plano, 'sem_preferencia', (v_turno is null and v_apos is null and v_ate is null and v_dia is null and v_h is null),
    'horario', case when v_h is not null then jsonb_build_object('data', v_hdata, 'hora', v_hhora, 'unidade', left(v_h ->> 'unidade', 40), 'profissional', left(v_h ->> 'profissional', 80)) end));
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_lista from (select e from jsonb_array_elements(coalesce(p.informado -> 'pedidos', '[]'::jsonb) || jsonb_build_array(v_ped)) with ordinality t(e, o) order by o desc limit 10) z;
  update public.pmarc_pessoa set informado = informado || jsonb_build_object('pedidos', v_lista), aceitou_lgpd_em = coalesce(aceitou_lgpd_em, now()),
    ultimo_acesso_em = now(), atualizado_em = now() where id = p.id;

  v_conv := public.pmarc_conversa_garantir(p.id);
  if v_conv is not null then
    v_msg := 'Pedido de previsão: ' || coalesce(v_nome, v_txt, 'não escolheu o exame (quer conversar)') || '.'
      || case when v_h is not null then E'\nHorário que viu: ' || to_char(v_hdata, 'DD/MM/YYYY') || ' ' || v_hhora
            || coalesce(' · ' || nullif(v_h ->> 'unidade', ''), '') || coalesce(' · ' || nullif(v_h ->> 'profissional', ''), '') || ' (previsão, não reservado)' else '' end
      || case when v_turno is not null then E'\nTurno: ' || case v_turno when 'manha' then 'manhã' when 'tarde' then 'tarde' else 'noite' end else '' end
      || case when v_apos is not null then E'\nA partir das: ' || v_apos else '' end
      || case when v_ate is not null then E'\nAté as: ' || v_ate else '' end
      || case when v_dia is not null then E'\nAté o dia: ' || to_char(v_dia, 'DD/MM/YYYY') else '' end
      || case when v_unid is not null then E'\nUnidade: ' || v_unid else '' end
      || case when v_turno is null and v_apos is null and v_ate is null and v_dia is null and v_h is null then E'\nSem preferência de horário: só quer ver a disponibilidade.' else '' end
      || case when v_plano is not null then E'\nPlano/convênio informado: ' || v_plano || ' (conferir; cobertura e valor são com a equipe)' else '' end
      || case when v_obs is not null then E'\nObservação: ' || v_obs else '' end;
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_msg);
    if coalesce(p.informado ->> 'final_em', '') = '' then
      insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'agente', public.pmarc_texto('previsao_marcacao_final'));
      update public.pmarc_pessoa set informado = informado || jsonb_build_object('final_em', now()) where id = p.id;
    end if;
  end if;
  return public.pmarc_vista(p.id) || jsonb_build_object('sem_celular', v_conv is null);
end $function$;

