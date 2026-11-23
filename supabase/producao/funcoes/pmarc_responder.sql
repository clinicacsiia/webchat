-- public.pmarc_responder(p_codigo text, p_dados jsonb)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.pmarc_responder(p_codigo text, p_dados jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  p public.pmarc_pessoa; d jsonb := case when jsonb_typeof(p_dados) = 'object' then p_dados else '{}'::jsonb end;
  v_resp text; v_info jsonb; v_txt text; v_obs text; v_conv uuid; v_msg text; v_cel text; v_email text; v_cpf text; v_nasc date; v_nome text; v_primeira boolean; v_reab boolean := false;
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
    v_reab := public.pmarc_conversa_reabrir(p.id, v_conv);   -- 23/11/2026: conversa encerrada volta para a fila do painel
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
    if v_reab or coalesce(v_info ->> 'final_em', '') = '' then
      insert into public.mensagens (conversa_id, autor, texto) values (v_conv, 'agente', public.pmarc_texto('previsao_marcacao_final'));
      update public.pmarc_pessoa set informado = informado || jsonb_build_object('final_em', now()) where id = p.id;
    end if;
  end if;
  return public.pmarc_vista(p.id) || jsonb_build_object('sem_celular', v_conv is null);
end $function$;

