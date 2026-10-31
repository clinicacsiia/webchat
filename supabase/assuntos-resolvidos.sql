-- Outro assunto: o chat resolve sozinho o que dá, em vez de mandar tudo para o atendente. Escrito em 31/10/2026; AINDA NÃO aplicado no projeto webchat-atendimento.
-- Antes: Remarcar, Cancelar, Resultado de exame, Dúvida, Reclamação e Outro terminavam todos em "Conte em poucas palavras", e um atendente lia.
-- Agora:
--   * Cancelar: se o paciente já foi identificado (data de nascimento conferida) e tem exame marcado para o futuro, o chat lista os horários
--     ("Encontrei estes horários marcados. Qual você quer cancelar?"), pede um "sim" e entrega à equipe o pedido pronto (qual exame, qual dia).
--     O atendente só cancela no sistema e confirma. Sem texto digitado.
--   * Remarcar: mesma lista. Escolhendo o horário mais recente, o exame é copiado e o paciente segue direto para o convênio e o calendário, escolhendo o
--     novo horário sozinho; a equipe recebe a nota "REMARCAÇÃO de ..." para cancelar o horário antigo. Escolhendo outro horário da lista, vai para a
--     equipe já dizendo qual.
--   * Resultado de exame: mostra a orientação cadastrada em fluxo_texto.resultado_orientacao (link do portal, por exemplo) com dois botões:
--     "Resolveu, obrigado" (encerra) e "Preciso de um atendente". ENQUANTO O TEXTO ESTIVER VAZIO, tudo continua como antes (vai para a equipe).
--     Para ligar: update public.fluxo_texto set texto = 'Seu resultado fica em ... Acesse: https://... ' where chave = 'resultado_orientacao';
--   * Dúvida, Reclamação, Outro assunto e quem não foi identificado ou não tem horário marcado: continuam indo para a equipe, como antes.
-- Cada trecho trocado nas funções do motor tem de aparecer UMA vez; se não aparecer, o arquivo para sem alterar nada. Pode ser aplicado de novo sem efeito.
-- Ordem de aplicação: depois de fase7-motor.sql, fase4-paciente-que-volta.sql e correcao-convenio-quem-volta.sql.
-- Para voltar atrás: reaplique fase7-motor.sql e correcao-convenio-quem-volta.sql (as funções fluxo_assunto_* e os textos novos podem ficar: nada os usa).

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

-- 1. Textos (a equipe edita no painel; "on conflict do nothing" não mexe em texto já editado).
insert into public.fluxo_texto (chave, texto, descricao) values
 ('assunto_qual_remarcar', 'Encontrei estes horários marcados. Qual você quer remarcar?', 'Remarcar: lista dos exames marcados para o futuro'),
 ('assunto_qual_cancelar', 'Encontrei estes horários marcados. Qual você quer cancelar?', 'Cancelar: lista dos exames marcados para o futuro'),
 ('assunto_confirma', 'Você quer cancelar {item}? Um atendente faz o cancelamento no sistema e confirma com você.', 'Cancelar: pede o "sim" antes de avisar a equipe'),
 ('assunto_remarcar_ok', 'Certo! Vamos escolher o novo horário para {item}. O atendente cancela o horário antigo e confirma o novo com você.', 'Remarcar: antes de abrir o convênio e o calendário'),
 ('resultado_orientacao', '', 'Resultado de exame: o que dizer ao paciente (por exemplo o link do portal). VAZIO = o resultado vai direto para o atendente.'),
 ('assunto_fim', 'Que bom que deu certo! Se precisar de mais alguma coisa, é só chamar.', 'Resultado de exame: depois de "Resolveu, obrigado"')
on conflict (chave) do nothing;

-- 2. Exames marcados para o futuro, só para quem já teve a data de nascimento conferida (a mesma regra do histórico).
create or replace function public.fluxo_assunto_futuros(p_conversa uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_hist jsonb; r jsonb := '[]'::jsonb; u jsonb; i int := 0; x text;
begin
  v_hist := public.paciente_historico_para_ia(p_conversa);
  if not coalesce((v_hist ->> 'liberado')::boolean, false) then return r; end if;
  for u in select value from jsonb_array_elements(coalesce(v_hist -> 'ultimas', '[]'::jsonb)) loop
    if coalesce((u ->> 'futuro')::boolean, false) and jsonb_array_length(coalesce(u -> 'exames', '[]'::jsonb)) > 0 then
      select string_agg(initcap(lower(coalesce(e ->> 'exame', e ->> 'modalidade'))) || coalesce(' (' || (e ->> 'lado') || ')', ''), ' + ')
        into x from jsonb_array_elements(u -> 'exames') e;
      r := r || jsonb_build_object('idx', i, 'rotulo', x || ' — ' || (u ->> 'quando'), 'item', x || ' de ' || (u ->> 'quando'));
    end if;
    i := i + 1;
  end loop;
  return r;
end $$;
revoke all on function public.fluxo_assunto_futuros(uuid) from public, anon, authenticated;

-- 3. Qual é o próximo passo dentro de "Outro assunto".
create or replace function public.fluxo_proximo_assunto(p_conversa uuid, d jsonb) returns text
language plpgsql stable security definer set search_path to '' as $$
declare v_res text;
begin
  if d ->> 'assunto' is null then return 'assunto'; end if;
  if coalesce((d ->> 'assunto_resolvido')::boolean, false) then return 'assunto_fim'; end if;
  if d ->> 'assunto' = 'Resultado de exame' and not coalesce((d ->> 'assunto_resultado_feito')::boolean, false) then
    select nullif(btrim(texto), '') into v_res from public.fluxo_texto where chave = 'resultado_orientacao';
    if v_res is not null then return 'assunto_resultado'; end if;
  end if;
  if d ->> 'assunto' in ('Remarcar', 'Cancelar') then
    if d ->> 'assunto_item' is not null and d ->> 'assunto' = 'Cancelar' and not coalesce((d ->> 'assunto_confirmado')::boolean, false) then
      return 'assunto_confirma';
    end if;
    if d ->> 'assunto_item' is null and not coalesce((d ->> 'assunto_qual_feito')::boolean, false)
       and jsonb_array_length(public.fluxo_assunto_futuros(p_conversa)) > 0 then
      return 'assunto_qual';
    end if;
  end if;
  return 'assunto_texto';
end $$;
revoke all on function public.fluxo_proximo_assunto(uuid, jsonb) from public, anon, authenticated;

-- 4. A pergunta de cada passo novo: devolve {texto, op} (op = o componente de botões).
create or replace function public.fluxo_assunto_pergunta(p_conversa uuid, p_passo text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare d jsonb; ctx jsonb := public.fluxo_ctx(p_conversa); v_it jsonb := '[]'::jsonb; f jsonb;
begin
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  case p_passo
  when 'assunto_qual' then
    for f in select value from jsonb_array_elements(public.fluxo_assunto_futuros(p_conversa)) loop
      v_it := v_it || jsonb_build_object('valor', 'i' || (f ->> 'idx'), 'rotulo', f ->> 'rotulo');
    end loop;
    v_it := v_it || jsonb_build_object('valor', 'nenhum', 'rotulo', 'Não é nenhum destes');
    return jsonb_build_object('texto', public.fluxo_t('assunto_qual_' || lower(coalesce(d ->> 'assunto', 'remarcar')), ctx), 'op', public.fluxo_escolha(p_passo, v_it));
  when 'assunto_confirma' then
    return jsonb_build_object('texto', public.fluxo_t('assunto_confirma', ctx || jsonb_build_object('item', coalesce(d ->> 'assunto_item', 'este horário'))),
      'op', public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'sim', 'rotulo', 'Sim, cancelar'), jsonb_build_object('valor', 'nao', 'rotulo', 'Não, voltar'))));
  when 'assunto_resultado' then
    return jsonb_build_object('texto', (select btrim(texto) from public.fluxo_texto where chave = 'resultado_orientacao'),
      'op', public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'resolvido', 'rotulo', 'Resolveu, obrigado'), jsonb_build_object('valor', 'atendente', 'rotulo', 'Preciso de um atendente'))));
  else
    return jsonb_build_object('texto', public.fluxo_t('assunto_fim', ctx), 'op', jsonb_build_object('tipo', 'nova'));
  end case;
end $$;
revoke all on function public.fluxo_assunto_pergunta(uuid, text) from public, anon, authenticated;

-- 5. A resposta de cada passo novo (botão ou texto lido). Devolve o mesmo formato de fluxo_aplicar.
create or replace function public.fluxo_assunto_aplicar(p_conversa uuid, p_passo text, v text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare d jsonb; ctx jsonb := public.fluxo_ctx(p_conversa); f jsonb; x text;
begin
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  case p_passo
  when 'assunto_resultado' then
    if v = 'resolvido' then perform public.fluxo_set(p_conversa, '{"assunto_resolvido": true}');
    elsif v = 'atendente' then perform public.fluxo_set(p_conversa, '{"assunto_resultado_feito": true}');
    else return '{"ok": false}'; end if;
  when 'assunto_confirma' then
    if v = 'sim' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_confirmado', true, 'assunto_texto', left('Cancelar ' || coalesce(d ->> 'assunto_item', ''), 500)));
      return '{"ok": true, "transferir": true}';
    elsif v = 'nao' then
      perform public.fluxo_set(p_conversa, '{"assunto_item": null, "assunto_qual_feito": true}');
    else return '{"ok": false}'; end if;
  when 'assunto_qual' then
    if v = 'nenhum' then
      perform public.fluxo_set(p_conversa, '{"assunto_qual_feito": true}');
      return '{"ok": true}';
    end if;
    if v is null or v !~ '^i[0-9]{1,2}$' then return '{"ok": false}'; end if;
    select e into f from jsonb_array_elements(public.fluxo_assunto_futuros(p_conversa)) e where (e ->> 'idx')::int = substr(v, 2)::int;
    if f is null then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_item', f ->> 'item', 'assunto_qual_feito', true));
    if d ->> 'assunto' = 'Remarcar' then
      if (f ->> 'idx')::int = 0 and public.pre_reaproveitar(p_conversa, 'ultimo') then
        x := public.paciente_historico_para_ia(p_conversa) -> 'ultimas' -> 0 ->> 'plano';
        perform public.fluxo_set(p_conversa, jsonb_build_object('motivo', 'exame', 'assunto_item', null,
          'plano_anterior', case when nullif(btrim(coalesce(x, '')), '') is not null then left(btrim(x), 120) else null end));
        perform public.fluxo_nota(p_conversa, 'REMARCAÇÃO de ' || (f ->> 'item') || ': cancelar o horário antigo no sistema e marcar o novo');
        return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('assunto_remarcar_ok', ctx || jsonb_build_object('item', f ->> 'item')));
      end if;
      perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', left('Remarcar ' || (f ->> 'item'), 500)));
      return '{"ok": true, "transferir": true}';
    end if;
  else
    return '{"ok": false}';
  end case;
  return '{"ok": true}';
end $$;
revoke all on function public.fluxo_assunto_aplicar(uuid, text, text) from public, anon, authenticated;

-- 6. Liga os passos novos ao motor.
select pg_temp.remendar('public.fluxo_proximo(uuid)'::regprocedure, 'fluxo_proximo_assunto',
  array[$q$    return case when d ->> 'assunto' is null then 'assunto' else 'assunto_texto' end;$q$],
  array[$q$    return public.fluxo_proximo_assunto(p_conversa, d);$q$]);

select pg_temp.remendar('public.fluxo_perguntar(uuid,text,text)'::regprocedure, 'fluxo_assunto_pergunta',
  array[E'  when ''assunto_texto'' then\n    v_txt := public.fluxo_t(''assunto_texto'', ctx);'],
  array[E'  when ''assunto_qual'', ''assunto_confirma'', ''assunto_resultado'', ''assunto_fim'' then\n    v_op := public.fluxo_assunto_pergunta(p_conversa, p_passo);\n    v_txt := v_op ->> ''texto'';\n    v_op := v_op -> ''op'';\n  when ''assunto_texto'' then\n    v_txt := public.fluxo_t(''assunto_texto'', ctx);']);

select pg_temp.remendar('public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure, 'fluxo_assunto_aplicar',
  array[E'  when ''assunto_texto'' then\n    x := btrim(coalesce(v, o ->> ''texto'', ''''));'],
  array[E'  when ''assunto_qual'', ''assunto_confirma'', ''assunto_resultado'' then\n    return public.fluxo_assunto_aplicar(p_conversa, p_passo, v);\n  when ''assunto_texto'' then\n    x := btrim(coalesce(v, o ->> ''texto'', ''''));']);

-- Quem digita em vez de tocar: "sim"/"não" no cancelamento, "resolveu"/"preciso de atendente" no resultado.
select pg_temp.remendar('public.fluxo_ler_texto(uuid,text,text)'::regprocedure, 'assunto_confirma',
  array[E'  when ''assunto_texto'' then\n    return jsonb_build_object(''texto'', left(btrim(p_texto), 500));'],
  array[E'  when ''assunto_confirma'' then\n    if sim then return ''"sim"''; end if;\n    if nao then return ''"nao"''; end if;\n  when ''assunto_resultado'' then\n    if sim or t ~ ''(resolv|obrigad|valeu|deu certo)'' then return ''"resolvido"''; end if;\n    if nao then return ''"atendente"''; end if;\n  when ''assunto_texto'' then\n    return jsonb_build_object(''texto'', left(btrim(p_texto), 500));']);

-- Depois de "Resolveu, obrigado", se o paciente voltar a escrever a conversa vai para a equipe (como depois do pedido pronto).
select pg_temp.remendar('public.fluxo_avancar(uuid,jsonb)'::regprocedure, 'assunto_fim',
  array[$q$  elsif v_passo in ('pronto', 'humano') then$q$],
  array[$q$  elsif v_passo in ('pronto', 'humano', 'assunto_fim') then$q$]);
