-- Correção: o convênio de quem volta nunca é copiado em silêncio. NÃO APLICADO ainda no projeto webchat-atendimento.
-- Antes:
--   * "Continuar o pedido que ficou pela metade" copiava o convênio da conversa antiga (pre_reaproveitar) e o motor pulava a pergunta do plano;
--     quem trocou de convênio seguia com o antigo e só percebia lendo o resumo final.
--   * "Corrigir o plano" apagava só o plano: a carteirinha digitada do convênio antigo continuava valendo.
--   * "Corrigir a consulta" não refazia o horário (só "Corrigir o exame" refazia).
-- Agora:
--   * O convênio da vez anterior vira uma pergunta com dois botões grandes: "Da última vez foi pelo convênio X. É assim também agora?"
--     ("Sim, é o mesmo" / "Não, mudou"). "Não, mudou" abre a lista de convênios de sempre. Vale para "Repetir o último exame" e para
--     "Continuar o pedido que ficou pela metade".
--   * Se a pessoa corrige o plano na confirmação e escolhe OUTRO convênio, a carteirinha e a validade digitadas saem e a carteirinha é pedida
--     de novo. Se escolhe o mesmo convênio, nada é apagado. O horário já escolhido é mantido (é uma previsão), com um aviso à pessoa e uma
--     nota para o atendente conferir se o médico/unidade atende o convênio novo.
--   * Trocar a consulta passa a refazer o horário, como já acontecia ao trocar o exame.
-- Cada bloco falha sem alterar nada se o ponto de substituição não for encontrado (ou se aparecer mais de uma vez), e pode ser aplicado de
-- novo sem efeito. Sem comandos destrutivos. Para voltar atrás, reaplique os arquivos fase4-paciente-que-volta.sql e fase7-motor.sql
-- (os textos novos em fluxo_texto podem ficar: nada os usa).
-- Ordem de aplicação: depois de fase4-paciente-que-volta.sql e fase7-motor.sql.

-- Auxiliar (existe só nesta sessão): troca trechos exatos no corpo de uma função; cada trecho tem de aparecer UMA vez.
create or replace function pg_temp.remendar(p_funcao regprocedure, p_marca text, p_de text[], p_para text[]) returns text
language plpgsql as $$
declare d text; d2 text; i int; n int;
begin
  d := pg_get_functiondef(p_funcao);
  if position(p_marca in d) > 0 then return 'já aplicado: ' || p_funcao::text; end if;
  d2 := d;
  for i in 1 .. array_length(p_de, 1) loop
    n := (length(d2) - length(replace(d2, p_de[i], ''))) / length(p_de[i]);
    if n <> 1 then
      raise exception '% : o trecho % aparece % vez(es); nada foi alterado.', p_funcao::text, i, n;
    end if;
    d2 := replace(d2, p_de[i], p_para[i]);
  end loop;
  execute d2;
  return 'aplicado: ' || p_funcao::text;
end $$;

-- 1. Textos novos (a equipe pode editar no painel; "on conflict do nothing" não mexe em texto já editado).
insert into public.fluxo_texto (chave, texto, descricao) values
 ('plano_confirma', 'Da última vez o atendimento foi {como}. É assim também agora?', 'Paciente que volta: confirma o convênio da vez anterior'),
 ('plano_trocado', 'Convênio atualizado. Vou pedir o número da carteirinha de novo.', 'Corrigiu o plano na confirmação e escolheu outro convênio'),
 ('plano_trocado_horario', 'Convênio atualizado. Vou pedir o número da carteirinha de novo, e o atendente confere se o horário que você escolheu atende esse convênio.', 'Idem, quando já havia horário escolhido')
on conflict (chave) do nothing;

-- 2. pre_reaproveitar: não copia mais o plano da conversa antiga (a unidade continua sendo copiada).
select pg_temp.remendar('public.pre_reaproveitar(uuid,text)'::regprocedure, 'convenio-quem-volta',
  array[E'    plano = case when v_orig is not null then coalesce(pa.plano, (select o.plano from public.pre_agendamentos o where o.conversa_id = v_orig)) else pa.plano end,\n'],
  array[E'    -- convenio-quem-volta: o plano da vez anterior NÃO é copiado; o motor pergunta se continua o mesmo.\n']);

-- 3. fluxo_proximo: com um plano da vez anterior guardado e nenhum plano na conversa, confirma antes de abrir a lista.
select pg_temp.remendar('public.fluxo_proximo(uuid)'::regprocedure, 'plano_confirma',
  array[E'  if pa.plano is null then return ''plano''; end if;'],
  array[E'  if pa.plano is null then\n    if d ->> ''plano_anterior'' is not null then return ''plano_confirma''; end if;\n    return ''plano'';\n  end if;']);

-- 4. fluxo_perguntar: a pergunta nova e a etapa do pré-agendamento.
select pg_temp.remendar('public.fluxo_perguntar(uuid,text,text)'::regprocedure, 'plano_confirma',
  array[E'  when ''horario'' then\n    v_txt := public.fluxo_t(''horario'', ctx);',
        E'when p_passo = ''plano'' then ''plano'''],
  array[E'  when ''plano_confirma'' then\n    x := d ->> ''plano_anterior'';\n    v_txt := public.fluxo_t(''plano_confirma'', ctx || jsonb_build_object(''como'',\n      case when lower(btrim(x)) = ''particular'' then ''particular'' else ''pelo convênio '' || initcap(lower(x)) end));\n    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object(''valor'', ''sim'', ''rotulo'', ''Sim, é o mesmo''),\n                                                            jsonb_build_object(''valor'', ''nao'', ''rotulo'', ''Não, mudou'')));\n  when ''horario'' then\n    v_txt := public.fluxo_t(''horario'', ctx);',
        E'when p_passo in (''plano'', ''plano_confirma'') then ''plano'''] );

-- 5. fluxo_aplicar: guarda o plano da vez anterior ao reaproveitar; responde a pergunta; troca de convênio na correção.
select pg_temp.remendar('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure, 'plano_confirma',
  array[
    -- (a) atalho: o plano antigo vira "plano_anterior" em vez de ser copiado.
    E'    if v in (''ultimo'', ''pendente'') then\n      v_ok := public.pre_reaproveitar(p_conversa, v);\n      if v_ok then perform public.fluxo_set(p_conversa, ''{"motivo": "exame"}'');',
    -- (b) resposta da pergunta nova.
    E'  when ''horario'' then\n    if v = ''sem_horario'' then',
    -- (c) escolha de convênio: limpa o "anterior" e, se veio de uma correção para OUTRO convênio, tira a carteirinha.
    E'    perform public.fluxo_pre(p_conversa, jsonb_build_object(''plano'', left(x, 120), ''etapa'', ''plano''));\n    if o ->> ''outro'' is not null then',
    -- (d) "Corrigir o plano" guarda de qual convênio a pessoa saiu.
    E'    elsif v = ''plano'' then update public.pre_agendamentos set plano = null where conversa_id = p_conversa; perform public.fluxo_set(p_conversa, ''{"confirmado": false}'');'
  ],
  array[
    E'    if v in (''ultimo'', ''pendente'') then\n      -- convenio-quem-volta: o convênio da vez anterior não é copiado; vira pergunta ("plano_confirma").\n      x := case v when ''ultimo'' then public.paciente_historico_para_ia(p_conversa) -> ''ultimas'' -> 0 ->> ''plano''\n                  else (select o2.plano from public.pre_agendamentos o2 where o2.conversa_id = public.pre_pendencia_anterior(p_conversa)) end;\n      v_ok := public.pre_reaproveitar(p_conversa, v);\n      if v_ok and nullif(btrim(coalesce(x, '''')), '''') is not null then\n        perform public.fluxo_set(p_conversa, jsonb_build_object(''plano_anterior'', left(btrim(x), 120)));\n      end if;\n      if v_ok then perform public.fluxo_set(p_conversa, ''{"motivo": "exame"}'');',
    E'  when ''plano_confirma'' then\n    select dados ->> ''plano_anterior'' into x from public.conversa_fluxo where conversa_id = p_conversa;\n    if v = ''sim'' then\n      if x is not null then perform public.fluxo_pre(p_conversa, jsonb_build_object(''plano'', x, ''etapa'', ''plano'')); end if;\n      perform public.fluxo_set(p_conversa, ''{"plano_anterior": null}'');\n    elsif v = ''nao'' then\n      perform public.fluxo_set(p_conversa, ''{"plano_anterior": null}'');\n    else return ''{"ok": false}''; end if;\n  when ''horario'' then\n    if v = ''sem_horario'' then',
    E'    perform public.fluxo_pre(p_conversa, jsonb_build_object(''plano'', left(x, 120), ''etapa'', ''plano''));\n    perform public.fluxo_set(p_conversa, ''{"plano_anterior": null}'');\n    -- convenio-quem-volta: corrigiu o plano na confirmação e escolheu OUTRO convênio: a carteirinha antiga não vale mais.\n    select dados ->> ''plano_trocado_de'' into k from public.conversa_fluxo where conversa_id = p_conversa;\n    if k is not null then\n      perform public.fluxo_set(p_conversa, ''{"plano_trocado_de": null}'');\n      if lower(btrim(k)) is distinct from lower(btrim(left(x, 120))) then\n        perform public.fluxo_set(p_conversa, jsonb_build_object(''g_carteira'', false, ''confirmado'', false,\n          ''digitado'', coalesce((select dados -> ''digitado'' from public.conversa_fluxo where conversa_id = p_conversa), ''{}''::jsonb) - ''matricula'' - ''validade''));\n        if jsonb_array_length(coalesce(pa.escolha_horario, ''[]''::jsonb)) > 0 then\n          perform public.fluxo_nota(p_conversa, ''Convênio trocado de '' || k || '' para '' || left(x, 120) || '' depois de escolher o horário: conferir se o médico/unidade atende o convênio novo'');\n          if o ->> ''outro'' is null then return jsonb_build_object(''ok'', true, ''aviso'', public.fluxo_t(''plano_trocado_horario'')); end if;\n        elsif o ->> ''outro'' is null then\n          return jsonb_build_object(''ok'', true, ''aviso'', public.fluxo_t(''plano_trocado''));\n        end if;\n      end if;\n    end if;\n    if o ->> ''outro'' is not null then',
    E'    elsif v = ''plano'' then\n      perform public.fluxo_set(p_conversa, jsonb_build_object(''plano_trocado_de'', pa.plano, ''plano_anterior'', null, ''confirmado'', false));\n      update public.pre_agendamentos set plano = null where conversa_id = p_conversa;'
  ]);

-- 6. fluxo_ler_texto: a pessoa também pode digitar "sim" / "não, mudou" / "continua o mesmo".
select pg_temp.remendar('public.fluxo_ler_texto(uuid,text,text)'::regprocedure, 'plano_confirma',
  array[E'  when ''medico'' then\n    if t ~ ''(tanto faz'],
  array[E'  when ''plano_confirma'' then\n    if t ~ ''(nao (mudou|mudei|mudaram|trocou|troquei)|nada mudou|continua|continuo)'' then return ''"sim"''; end if;\n    if nao or t ~ ''(mudou|mudei|mudaram|trocou|troquei|outro|novo|nova|diferente)'' then return ''"nao"''; end if;\n    if sim or t ~ ''(mesmo|igual)'' then return ''"sim"''; end if;\n  when ''medico'' then\n    if t ~ ''(tanto faz']);

-- 7. fluxo_avancar: trocar a CONSULTA também refaz o horário (antes só trocar o exame refazia).
select pg_temp.remendar('public.fluxo_avancar(uuid,jsonb)'::regprocedure, 'convenio-quem-volta',
  array[E'     where conversa_id = p_conversa and v_texto like ''Pedido de exames:%'' and escolha_horario is not null and status = ''rascunho'';'],
  array[E'     where conversa_id = p_conversa and escolha_horario is not null and status = ''rascunho'';   -- convenio-quem-volta: exame ou consulta']);
