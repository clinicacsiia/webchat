-- public.fluxo_aplicar(p_conversa uuid, p_passo text, p_valor jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_aplicar(p_conversa uuid, p_passo text, p_valor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v text := case when jsonb_typeof(p_valor) = 'string' then p_valor #>> '{}' else null end;
  o jsonb := case when jsonb_typeof(p_valor) = 'object' then p_valor else '{}'::jsonb end;
  c public.conversas; pa public.pre_agendamentos; ctx jsonb := public.fluxo_ctx(p_conversa);
  v_dt date; v_pac jsonb := '{}'::jsonb; v_err text[] := '{}'; v_ok boolean; v_med text[]; k text; x text; v_uni text;
begin
  select * into c from public.conversas where id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  case p_passo
  when 'identidade' then
    if coalesce((o ->> 'pular')::boolean, false) then perform public.fluxo_set(p_conversa, '{"identidade_feita": true}'); return '{"ok": true}'; end if;
    v_dt := public.fluxo_ler_data(o ->> 'dt_nasc');
    if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', public.fluxo_t('identidade_erro')); end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', jsonb_build_object('dt_nasc', v_dt::text)));
    perform public.fluxo_set(p_conversa, jsonb_build_object('identidade_feita', true, 'digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb) || jsonb_build_object('dt_nasc', to_char(v_dt, 'DD/MM/YYYY'))));
  when 'cpf_nasc' then   -- klingo-auto
    x := regexp_replace(coalesce(o ->> 'cpf', ''), '\D', '', 'g');
    v_dt := public.fluxo_ler_data(o ->> 'dt_nasc');
    if not public.fluxo_cpf_ok(x) then v_err := array_append(v_err, 'o CPF (os números não conferem)'::text); end if;
    if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then v_err := array_append(v_err, 'a data de nascimento'::text); end if;
    if cardinality(v_err) > 0 then return jsonb_build_object('ok', false, 'erro', public.fluxo_t('dados_erro', jsonb_build_object('erros', array_to_string(v_err, ' e ')))); end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', jsonb_build_object('cpf', x, 'dt_nasc', v_dt::text)));
    perform public.fluxo_set(p_conversa, jsonb_build_object('digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb)
                                                             || jsonb_build_object('cpf', x, 'dt_nasc', to_char(v_dt, 'DD/MM/YYYY')), 'cpf_nasc_refazer', null));
  when 'atalho' then
    if v in ('ultimo', 'pendente') then
      -- convenio-quem-volta: o convênio da vez anterior não é copiado; vira pergunta ("plano_confirma").
      x := case v when 'ultimo' then public.paciente_historico_para_ia(p_conversa) -> 'ultimas' -> 0 ->> 'plano'
                  else (select o2.plano from public.pre_agendamentos o2 where o2.conversa_id = public.pre_pendencia_anterior(p_conversa)) end;
      v_ok := public.pre_reaproveitar(p_conversa, v);
      if v_ok and nullif(btrim(coalesce(x, '')), '') is not null and public.convenio_ativo(x) then   -- convenios-e-foto: convênio desativado depois não vira pergunta
        perform public.fluxo_set(p_conversa, jsonb_build_object('plano_anterior', left(btrim(x), 120)));
      end if;
      if v_ok then perform public.fluxo_set(p_conversa, '{"motivo": "exame"}');
      else return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('atalho_falhou')); end if;
    elsif v is distinct from 'outro' then return '{"ok": false}';
    end if;
  when 'motivo' then
    if v not in ('exame', 'consulta', 'assunto') then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('motivo', v));
    if v = 'consulta' then
      select u.chave into v_uni from public.unidade_config u
       where u.ativo and u.fluxo = case when (ctx ->> 'filho')::boolean then 'pediatria' else 'exame_consulta' end order by u.ordem limit 1;
      update public.conversas set unidade_inicial = v_uni where id = p_conversa;
    elsif v = 'exame' then
      update public.conversas set unidade_inicial = null where id = p_conversa;
    end if;
  when 'medico' then
    v_med := public.fluxo_medicos(p_conversa);
    if coalesce(v, '') <> '' and not (v = any(coalesce(v_med, '{}'))) then return '{"ok": false}'; end if;
    update public.conversas set medico_preferido = nullif(v, '') where id = p_conversa;
    if coalesce(v, '') <> '' then perform public.fluxo_pre(p_conversa, jsonb_build_object('profissional', v)); end if;
    perform public.fluxo_set(p_conversa, '{"medico_feito": true}');
  when 'assunto' then
    if coalesce(v, '') = '' then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('assunto', left(v, 60)));
  when 'exame_aberto', 'remarcar_falta' then
    return public.fluxo_pos_aplicar(p_conversa, p_passo, v);
  when 'assunto_qual', 'assunto_confirma', 'assunto_resultado' then
    return public.fluxo_assunto_aplicar(p_conversa, p_passo, v);
  when 'assunto_texto' then
    x := btrim(coalesce(v, o ->> 'texto', ''));
    if x = '' then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', left(x, 500)));
    return '{"ok": true, "transferir": true}';
  when 'plano' then
    x := btrim(coalesce(v, o ->> 'outro', ''));
    -- convenios-e-foto: convênio desativado pela gestão não é aceito; a pessoa escolhe outro, Particular ou o atendente.
    if x <> '' and not public.convenio_ativo(x) then
      return jsonb_build_object('ok', false, 'erro', public.convenio_msg(x, 'inativo'));
    end if;
    if x = '' then return '{"ok": false}'; end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('plano', left(x, 120), 'etapa', 'plano'));
    perform public.fluxo_set(p_conversa, '{"plano_anterior": null}');
    perform public.convenio_avisar(p_conversa, x);   -- convenios-e-foto: aviso e regra "um exame por vez"
    -- convenio-quem-volta: corrigiu o plano na confirmação e escolheu OUTRO convênio: a carteirinha antiga não vale mais.
    select dados ->> 'plano_trocado_de' into k from public.conversa_fluxo where conversa_id = p_conversa;
    if k is not null then
      perform public.fluxo_set(p_conversa, '{"plano_trocado_de": null}');
      if lower(btrim(k)) is distinct from lower(btrim(left(x, 120))) then
        perform public.fluxo_set(p_conversa, jsonb_build_object('g_carteira', false, 'confirmado', false,
          'digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb) - 'matricula' - 'validade'));
        if jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) > 0 then
          perform public.fluxo_nota(p_conversa, 'Convênio trocado de ' || k || ' para ' || left(x, 120) || ' depois de escolher o horário: conferir se o médico/unidade atende o convênio novo');
          if o ->> 'outro' is null then return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('plano_trocado_horario')); end if;
        elsif o ->> 'outro' is null then
          return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('plano_trocado'));
        end if;
      end if;
    end if;
    if o ->> 'outro' is not null then
      perform public.fluxo_nota(p_conversa, 'Convênio digitado pelo paciente (fora da lista): ' || x);
      perform public.fluxo_set(p_conversa, '{"confirmado": false}');
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('plano_outro', jsonb_build_object('plano', left(x, 120))));
    end if;
  when 'plano_confirma' then
    select dados ->> 'plano_anterior' into x from public.conversa_fluxo where conversa_id = p_conversa;
    if v = 'sim' then
      if x is not null then perform public.fluxo_pre(p_conversa, jsonb_build_object('plano', x, 'etapa', 'plano')); end if;
      perform public.fluxo_set(p_conversa, '{"plano_anterior": null}');
    elsif v = 'nao' then
      perform public.fluxo_set(p_conversa, '{"plano_anterior": null}');
    else return '{"ok": false}'; end if;
  when 'horario' then
    if v = 'sem_horario' then
      perform public.fluxo_set(p_conversa, '{"sem_horario": true}');
      perform public.fluxo_nota(p_conversa, 'Nenhum horário do calendário serviu: procurar outro com o paciente');
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('horario_nenhum'));
    end if;
    return '{"ok": false}';
  when 'mudou' then
    if v = 'igual' then perform public.fluxo_set(p_conversa, '{"mudou": "igual", "g_ident": true, "g_contato": true, "g_endereco": true}');
    elsif v = 'mudou' then perform public.fluxo_set(p_conversa, '{"mudou": "mudou"}');
    else return '{"ok": false}'; end if;
  when 'dados_ident', 'dados_contato', 'dados_endereco', 'dados_carteira' then
    if coalesce((o ->> 'pular')::boolean, false) and p_passo in ('dados_endereco', 'dados_carteira') then
      perform public.fluxo_set(p_conversa, jsonb_build_object(case p_passo when 'dados_endereco' then 'g_endereco' else 'g_carteira' end, true));
      perform public.fluxo_nota(p_conversa, case p_passo when 'dados_endereco' then 'Endereço não informado' else 'Carteirinha não informada' end);
      return '{"ok": true}';
    end if;
    foreach k in array case p_passo
        when 'dados_ident' then array['nome','sexo','dt_nasc','cpf']
        when 'dados_contato' then array['celular','telefone','email']
        when 'dados_endereco' then array['cep','endereco','numero','complemento','bairro','cidade','uf']
        else array['matricula','validade'] end loop
      x := nullif(btrim(coalesce(o ->> k, '')), '');
      if x is null then continue; end if;
      if k in ('dt_nasc', 'validade') then
        v_dt := public.fluxo_ler_data(x);
        if v_dt is null or (k = 'dt_nasc' and (v_dt > current_date or v_dt < date '1900-01-01')) then
          v_err := array_append(v_err, case k when 'dt_nasc' then 'a data de nascimento' else 'a validade' end); continue;
        end if;
        x := v_dt::text;
      elsif k = 'cpf' then
        if not public.fluxo_cpf_ok(x) then v_err := array_append(v_err, 'o CPF (os números não conferem)'::text); continue; end if;
      elsif k = 'email' then
        x := lower(x);
        if x !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_err := array_append(v_err, 'o e-mail'::text); continue; end if;
      elsif k in ('celular', 'telefone') then
        x := regexp_replace(x, '\D', '', 'g');
        if length(x) not in (10, 11) then v_err := array_append(v_err, case k when 'celular' then 'o celular (DDD + número)' else 'o outro telefone' end); continue; end if;
      elsif k = 'cep' then
        x := regexp_replace(x, '\D', '', 'g');
        if length(x) <> 8 then v_err := array_append(v_err, 'o CEP (8 números)'::text); continue; end if;
      elsif k = 'sexo' then
        x := upper(left(x, 1));
        if x not in ('M', 'F') then v_err := array_append(v_err, 'o sexo'::text); continue; end if;
      elsif k = 'uf' then
        x := upper(left(x, 2));
      elsif k = 'nome' and length(x) < 5 then
        v_err := array_append(v_err, 'o nome completo'::text); continue;
      end if;
      v_pac := v_pac || jsonb_build_object(k, left(x, 200));
    end loop;
    if p_passo = 'dados_ident' then
      if v_pac ->> 'nome' is null and not ('o nome completo' = any(v_err)) then v_err := array_append(v_err, 'o nome completo'::text); end if;
      if v_pac ->> 'sexo' is null and not ('o sexo' = any(v_err)) then v_err := array_append(v_err, 'o sexo'::text); end if;
      if v_pac ->> 'dt_nasc' is null and not ('a data de nascimento' = any(v_err)) then v_err := array_append(v_err, 'a data de nascimento'::text); end if;
      if v_pac ->> 'cpf' is null and not ('o CPF (os números não conferem)' = any(v_err)) then v_err := array_append(v_err, 'o CPF'::text); end if;
    elsif p_passo = 'dados_contato' and v_pac ->> 'celular' is null and not ('o celular (DDD + número)' = any(v_err)) then
      v_err := array_append(v_err, 'o celular (DDD + número)'::text);
    end if;
    if cardinality(v_err) > 0 then
      return jsonb_build_object('ok', false, 'erro', public.fluxo_t('dados_erro', jsonb_build_object('erros', array_to_string(v_err, ', '))));
    end if;
    if v_pac <> '{}'::jsonb then perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', v_pac, 'etapa', 'dados')); end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object(case p_passo when 'dados_ident' then 'g_ident' when 'dados_contato' then 'g_contato'
                                                             when 'dados_endereco' then 'g_endereco' else 'g_carteira' end, true,
      'digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb) || (o - 'pular')));
  when 'confirmar' then
    if v = 'ok' then perform public.fluxo_set(p_conversa, '{"confirmado": true}');
    elsif v = 'pedido' then perform public.fluxo_set(p_conversa, '{"refazer": "pedido", "confirmado": false}');
    elsif v = 'plano' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('plano_trocado_de', pa.plano, 'plano_anterior', null, 'confirmado', false));
      update public.pre_agendamentos set plano = null where conversa_id = p_conversa;
    elsif v = 'horario' then
      update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null where conversa_id = p_conversa;
      perform public.fluxo_set(p_conversa, '{"confirmado": false, "sem_horario": false}');
    elsif v = 'dados' then perform public.fluxo_set(p_conversa, '{"confirmado": false, "mudou": "mudou", "g_ident": false, "g_contato": false, "g_endereco": false, "g_carteira": false}');
    else return '{"ok": false}'; end if;
  else
    return '{"ok": false}';
  end case;
  return '{"ok": true}';
end $function$;

