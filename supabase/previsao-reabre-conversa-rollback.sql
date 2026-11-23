-- Versão 1.0 — 23/11/2026 / Mudança: desfaz supabase/previsao-reabre-conversa.sql (volta as 4 funções à versão anterior e apaga a função nova). Rodar no editor SQL (tem drop).

CREATE OR REPLACE FUNCTION public.pmarc_mensagens(p_codigo text, p_apos bigint DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.pmarc_pessoa;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, ''));
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  if p.conversa_id is null then return jsonb_build_object('ok', true, 'mensagens', '[]'::jsonb); end if;
  return jsonb_build_object('ok', true, 'mensagens', coalesce((
    select jsonb_agg(jsonb_build_object('id', m.id, 'autor', m.autor, 'texto', m.texto, 'criado_em', m.criado_em,
             'agente', coalesce(ag.nome, case when m.autor = 'agente' then 'Assistente virtual' end)) order by m.id)
    from public.mensagens m left join public.agentes ag on ag.id = m.agente_id
    where m.conversa_id = p.conversa_id and m.id > coalesce(p_apos, 0) and m.excluida_em is null), '[]'::jsonb));
end $function$;

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

CREATE OR REPLACE FUNCTION public.pmarc_responder(p_codigo text, p_dados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  p public.pmarc_pessoa; d jsonb := case when jsonb_typeof(p_dados) = 'object' then p_dados else '{}'::jsonb end;
  v_resp text; v_info jsonb; v_txt text; v_obs text; v_conv uuid; v_msg text; v_cel text; v_email text; v_cpf text; v_nasc date; v_nome text; v_primeira boolean;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;

  v_txt := nullif(left(btrim(coalesce(d ->> 'texto', '')), 1000), '');
  v_resp := coalesce(nullif(d ->> 'resposta', ''), public.pmarc_classificar(v_txt));
  if v_resp is not null and v_resp not in ('sim', 'nao', 'nao_sei') then v_resp := public.pmarc_classificar(v_resp); end if;
  v_obs := nullif(left(btrim(coalesce(d ->> 'observacao', '')), 1000), '');
  v_info := p.informado;

  v_nome := nullif(left(btrim(coalesce(d ->> 'nome', '')), 120), '');
  if v_nome is not null then v_info := v_info || jsonb_build_object('nome', v_nome); end if;
  if nullif(btrim(coalesce(d ->> 'celular', '')), '') is not null then
    v_cel := public.pmarc_telefone(d ->> 'celular');
    if v_cel is not null then v_info := v_info || jsonb_build_object('celular', v_cel);
    else v_info := v_info || jsonb_build_object('celular_digitado', left(regexp_replace(d ->> 'celular', '[^0-9+() -]', '', 'g'), 20), 'celular_revisar', true); end if;
  end if;
  if nullif(btrim(coalesce(d ->> 'email', '')), '') is not null then
    v_email := left(lower(btrim(d ->> 'email')), 200);
    v_info := v_info || jsonb_build_object('email', v_email) || case when v_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then jsonb_build_object('email_revisar', false) else jsonb_build_object('email_revisar', true) end;
  end if;
  if nullif(btrim(coalesce(d ->> 'cpf', '')), '') is not null then
    v_cpf := left(regexp_replace(d ->> 'cpf', '\D', '', 'g'), 14);
    v_info := v_info || jsonb_build_object('cpf', v_cpf, 'cpf_revisar', char_length(v_cpf) <> 11);
  end if;
  if nullif(btrim(coalesce(d ->> 'nascimento', '')), '') is not null then
    begin
      v_nasc := (d ->> 'nascimento')::date;
      if v_nasc between date '1900-01-01' and current_date then
        if p.nascimento is null then p.nascimento := v_nasc; else v_info := v_info || jsonb_build_object('nascimento', v_nasc, 'nascimento_revisar', v_nasc <> p.nascimento); end if;
      else v_info := v_info || jsonb_build_object('nascimento_digitado', left(d ->> 'nascimento', 20), 'nascimento_revisar', true); end if;
    exception when others then
      v_info := v_info || jsonb_build_object('nascimento_digitado', left(d ->> 'nascimento', 20), 'nascimento_revisar', true);
    end;
  end if;
  if v_obs is not null then v_info := v_info || jsonb_build_object('observacao', v_obs); end if;

  update public.pmarc_pessoa set
    informado = v_info, nascimento = p.nascimento, aceitou_lgpd_em = coalesce(aceitou_lgpd_em, now()),
    resposta = coalesce(v_resp, resposta), respondeu_em = case when v_resp is not null then now() else respondeu_em end,
    primeiro_acesso_em = coalesce(primeiro_acesso_em, now()), ultimo_acesso_em = now(), atualizado_em = now()
  where id = p.id;

  v_conv := public.pmarc_conversa_garantir(p.id);
  if v_conv is not null then
    v_msg := 'Previsão de marcação: ' || case v_resp when 'sim' then 'a pessoa disse que está certo.' when 'nao' then 'a pessoa disse que tem algo diferente.'
                                              when 'nao_sei' then 'a pessoa não sabe / pediu para seguir (nada foi barrado).' else 'a pessoa deixou os dados abaixo.' end
      || case when v_txt is not null and nullif(d ->> 'resposta', '') is null then E'\nDisse: ' || v_txt else '' end
      || case when v_obs is not null then E'\nObservação: ' || v_obs else '' end
      || case when v_nome is not null then E'\nNome: ' || v_nome else '' end
      || case when v_cel is not null then E'\nCelular: ' || v_cel when d ->> 'celular' is not null and btrim(d ->> 'celular') <> '' then E'\nCelular (conferir): ' || left(d ->> 'celular', 20) else '' end
      || case when v_email is not null then E'\nE-mail: ' || v_email else '' end
      || case when v_cpf is not null then E'\nCPF: ' || v_cpf else '' end
      || case when v_nasc is not null then E'\nNascimento: ' || to_char(v_nasc, 'DD/MM/YYYY') else '' end;
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_msg);
    update public.conversas set triagem_resumo = regexp_replace(coalesce(triagem_resumo, ''), '\s*Resposta à previsão:.*$', '') ||
      ' Resposta à previsão: ' || case coalesce(v_resp, p.resposta) when 'sim' then 'está certo' when 'nao' then 'tem algo diferente' when 'nao_sei' then 'não sei / seguimos (não bloquear)' else 'sem resposta ainda' end || '.'
      where id = v_conv;
    if coalesce(v_info ->> 'final_em', '') = '' then
      insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'agente', public.pmarc_texto('previsao_marcacao_final'));
      update public.pmarc_pessoa set informado = informado || jsonb_build_object('final_em', now()) where id = p.id;
    end if;
  end if;
  return public.pmarc_vista(p.id) || jsonb_build_object('sem_celular', v_conv is null);
end $function$;

CREATE OR REPLACE FUNCTION public.pmarc_enviar(p_codigo text, p_texto text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare p public.pmarc_pessoa; v_txt text; v_conv uuid; v_class text; v_id bigint; c public.conversas;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  v_txt := left(btrim(coalesce(p_texto, '')), 4000);
  if v_txt = '' then return jsonb_build_object('ok', false, 'motivo', 'texto_vazio'); end if;
  select * into p from public.pmarc_pessoa where codigo = btrim(coalesce(p_codigo, '')) for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'codigo_invalido'); end if;
  v_conv := public.pmarc_conversa_garantir(p.id);
  if v_conv is null then return jsonb_build_object('ok', false, 'motivo', 'sem_celular'); end if;
  if (select count(*) from public.mensagens where conversa_id = v_conv and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    return jsonb_build_object('ok', false, 'motivo', 'muitas_mensagens');
  end if;
  select * into c from public.conversas where id = v_conv;
  if c.status = 'encerrada' then
    update public.conversas set status = 'aguardando', agente_id = null where id = v_conv;
    -- reabrir religa o robô e apaga o resumo: aqui o robô continua desligado e o resumo volta
    update public.conversas set ia_ativa = false, triagem_resumo = c.triagem_resumo where id = v_conv;
  end if;
  insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'cliente', v_txt) returning id into v_id;
  -- "não sei", "seguimos"... também valem como resposta à previsão (e a pessoa recebe o aviso final uma única vez)
  v_class := public.pmarc_classificar(v_txt);
  update public.pmarc_pessoa set aceitou_lgpd_em = coalesce(aceitou_lgpd_em, now()), ultimo_acesso_em = now(), atualizado_em = now(),
    resposta = case when resposta is null and v_class is not null then v_class else resposta end,
    respondeu_em = case when resposta is null and v_class is not null then now() else respondeu_em end
  where id = p.id;
  if coalesce(p.informado ->> 'final_em', '') = '' then
    insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'agente', public.pmarc_texto('previsao_marcacao_final'));
    update public.pmarc_pessoa set informado = informado || jsonb_build_object('final_em', now()) where id = p.id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;

drop function if exists public.pmarc_conversa_reabrir(uuid, uuid);
