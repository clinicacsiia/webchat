-- FLUXOGRAMA: ver particular-valor-parte1-base.sql (passo novo `valor` para paciente Particular: valor da API em destaque; concordou = marca; recusou ou sem preço = equipe, sem cadastrar no Klingo)
-- Versão 1.0 — 16/11/2026 / Mudança: o passo `valor` na pergunta (fluxo_perguntar), na resposta (fluxo_aplicar) e no envio (fluxo_finalizar).
-- Cada bloco abaixo LÊ a definição que está no banco (pg_get_functiondef), troca só os trechos marcados (erro e nada aplicado se algum trecho não existir exatamente uma vez) e recria a função. Assim não pisa em mudanças de outras sessões. Rodar de novo não faz nada (marca "-- particular-valor").
-- Com particular_valor_modo = nao o comportamento é idêntico ao anterior.
-- ROLLBACK: recriar as funções a partir de supabase/producao/funcoes/ (versão anterior no git) ou desligar a chave particular_valor_modo.

-- ===== Parte 3 =====
do $patch$
declare d text; n text; sig regprocedure := 'public.fluxo_perguntar(uuid,text,text)'::regprocedure;
begin
  d := pg_get_functiondef(sig);
  if position('-- particular-valor' in d) > 0 then return; end if;   -- já aplicado
  n := d;
  if (length(n) - length(replace(n, $q13$v_etapa text; v_nse boolean; v_pref text := p_prefixo;$q13$, ''))) <> length($q14$v_etapa text; v_nse boolean; v_pref text := p_prefixo;$q14$) then raise exception 'particular-valor: trecho 1 de perguntar não encontrado ou repetido'; end if;
  n := replace(n, $q15$v_etapa text; v_nse boolean; v_pref text := p_prefixo;$q15$, $q16$v_etapa text; v_nse boolean; v_pref text := p_prefixo; v_val jsonb; v_linhas jsonb;$q16$);
  if (length(n) - length(replace(n, $q17$  when 'confirmar' then
    v_txt := public.fluxo_t('confirmar'$q17$, ''))) <> length($q18$  when 'confirmar' then
    v_txt := public.fluxo_t('confirmar'$q18$) then raise exception 'particular-valor: trecho 2 de perguntar não encontrado ou repetido'; end if;
  n := replace(n, $q19$  when 'confirmar' then
    v_txt := public.fluxo_t('confirmar'$q19$, $q20$  when 'valor' then   -- particular-valor: o valor da API, em destaque; sem preço, a assistência informa
    v_val := public.particular_valor_obter(p_conversa);
    if coalesce((v_val ->> 'completo')::boolean, false) then
      select string_agg('• ' || (e ->> 'nome') || case when (e ->> 'qtd')::int > 1 then ' (' || (e ->> 'qtd') || 'x ' || public.preco_brl((e ->> 'unitario')::numeric) || ')' else '' end || ': ' || public.preco_brl((e ->> 'subtotal')::numeric), E'\n' order by t.ord),
             jsonb_agg(to_jsonb((e ->> 'nome') || case when (e ->> 'qtd')::int > 1 then ' (' || (e ->> 'qtd') || 'x)' else '' end || ': ' || public.preco_brl((e ->> 'subtotal')::numeric)) order by t.ord)
        into x, v_linhas from jsonb_array_elements(v_val -> 'itens') with ordinality as t(e, ord);
      v_txt := public.fluxo_t('valor', jsonb_build_object('itens', x, 'total', public.preco_brl((v_val ->> 'total')::numeric)));
      perform public.fluxo_set(p_conversa, jsonb_build_object('valor_exibido', jsonb_build_object('assin', public.particular_valor_assinatura(p_conversa), 'total', (v_val ->> 'total')::numeric)));
      v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'sim', 'rotulo', 'Concordo com o valor e quero marcar'),
                                                              jsonb_build_object('valor', 'nao', 'rotulo', 'Não quero marcar por causa do valor')),
                jsonb_build_object('destaque', jsonb_build_object('titulo', 'Valor total (Particular)', 'valor', public.preco_brl((v_val ->> 'total')::numeric), 'linhas', coalesce(v_linhas, '[]'::jsonb))));
    else
      perform public.particular_valor_disparar(p_conversa);
      v_txt := public.fluxo_t('valor_sem', ctx);
      v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'sim', 'rotulo', 'Sim, quero saber o valor'),
                                                              jsonb_build_object('valor', 'nao', 'rotulo', 'Não preciso do valor agora')));
    end if;
  when 'confirmar' then
    perform public.particular_valor_disparar(p_conversa);   -- particular-valor: pede o preço à API enquanto o paciente confere o resumo
    v_txt := public.fluxo_t('confirmar'$q20$);
  if (length(n) - length(replace(n, $q21$when p_passo = 'confirmar' then 'confirmacao' end;$q21$, ''))) <> length($q22$when p_passo = 'confirmar' then 'confirmacao' end;$q22$) then raise exception 'particular-valor: trecho 3 de perguntar não encontrado ou repetido'; end if;
  n := replace(n, $q23$when p_passo = 'confirmar' then 'confirmacao' end;$q23$, $q24$when p_passo in ('confirmar', 'valor') then 'confirmacao' end;$q24$);
  execute n;
end $patch$;

do $patch$
declare d text; n text; sig regprocedure := 'public.fluxo_aplicar(uuid,text,jsonb)'::regprocedure;
begin
  d := pg_get_functiondef(sig);
  if position('-- particular-valor' in d) > 0 then return; end if;   -- já aplicado
  n := d;
  if (length(n) - length(replace(n, $q25$v_med text[]; k text; x text; v_uni text;$q25$, ''))) <> length($q26$v_med text[]; k text; x text; v_uni text;$q26$) then raise exception 'particular-valor: trecho 1 de aplicar não encontrado ou repetido'; end if;
  n := replace(n, $q27$v_med text[]; k text; x text; v_uni text;$q27$, $q28$v_med text[]; k text; x text; v_uni text; v_val jsonb; v_ex jsonb;$q28$);
  if (length(n) - length(replace(n, $q29$    perform public.convenio_avisar(p_conversa, x);$q29$, ''))) <> length($q30$    perform public.convenio_avisar(p_conversa, x);$q30$) then raise exception 'particular-valor: trecho 2 de aplicar não encontrado ou repetido'; end if;
  n := replace(n, $q31$    perform public.convenio_avisar(p_conversa, x);$q31$, $q32$    perform public.particular_valor_disparar(p_conversa);   -- particular-valor: já pede o preço à API
    perform public.convenio_avisar(p_conversa, x);$q32$);
  if (length(n) - length(replace(n, $q33$  when 'confirmar' then
    if v = 'ok'$q33$, ''))) <> length($q34$  when 'confirmar' then
    if v = 'ok'$q34$) then raise exception 'particular-valor: trecho 3 de aplicar não encontrado ou repetido'; end if;
  n := replace(n, $q35$  when 'confirmar' then
    if v = 'ok'$q35$, $q36$  when 'valor' then   -- particular-valor
    if v not in ('sim', 'nao') then return '{"ok": false}'; end if;
    v_val := public.particular_valor_obter(p_conversa);
    if not coalesce((v_val ->> 'particular')::boolean, false) then return '{"ok": false}'; end if;
    if coalesce((v_val ->> 'completo')::boolean, false) then
      select f.dados -> 'valor_exibido' into v_ex from public.conversa_fluxo f where f.conversa_id = p_conversa;
      if v = 'sim' and ((v_ex ->> 'assin') is distinct from public.particular_valor_assinatura(p_conversa) or (v_ex ->> 'total')::numeric is distinct from (v_val ->> 'total')::numeric) then
        return jsonb_build_object('ok', false, 'erro', 'O valor foi atualizado. Confira de novo, por favor.');
      end if;
      perform public.fluxo_set(p_conversa, jsonb_build_object('valor_resp', jsonb_build_object('resp', case when v = 'sim' then 'aceito' else 'recusado' end,
        'assin', public.particular_valor_assinatura(p_conversa), 'total', (v_val ->> 'total')::numeric, 'itens', v_val -> 'itens', 'em', now())));
      perform public.fluxo_nota(p_conversa, case when v = 'sim' then 'Paciente VIU e ACEITOU o valor Particular de ' || public.preco_brl((v_val ->> 'total')::numeric) || ' (preço da API do Klingo).'
                                                  else 'Paciente VIU o valor Particular de ' || public.preco_brl((v_val ->> 'total')::numeric) || ' e RECUSOU: não cadastrar no Klingo.' end);
    else
      perform public.fluxo_set(p_conversa, jsonb_build_object('valor_resp', jsonb_build_object('resp', case when v = 'sim' then 'quer_valor' else 'dispensou' end,
        'assin', public.particular_valor_assinatura(p_conversa), 'em', now())));
      perform public.fluxo_nota(p_conversa, case when v = 'sim' then 'Particular SEM preço na API: o paciente QUER saber o valor (equipe responde).' else 'Particular SEM preço na API: o paciente não pediu o valor agora.' end);
    end if;
  when 'confirmar' then
    if v = 'ok'$q36$);
  execute n;
end $patch$;

do $patch$
declare d text; n text; sig regprocedure := 'public.fluxo_finalizar(uuid)'::regprocedure;
begin
  d := pg_get_functiondef(sig);
  if position('-- particular-valor' in d) > 0 then return; end if;   -- já aplicado
  n := d;
  if (length(n) - length(replace(n, $q37$declare ctx jsonb := public.fluxo_ctx(p_conversa); v_pode jsonb; v_op uuid; v_rem jsonb; pa public.pre_agendamentos;$q37$, ''))) <> length($q38$declare ctx jsonb := public.fluxo_ctx(p_conversa); v_pode jsonb; v_op uuid; v_rem jsonb; pa public.pre_agendamentos;$q38$) then raise exception 'particular-valor: trecho 1 de finalizar não encontrado ou repetido'; end if;
  n := replace(n, $q39$declare ctx jsonb := public.fluxo_ctx(p_conversa); v_pode jsonb; v_op uuid; v_rem jsonb; pa public.pre_agendamentos;$q39$, $q40$declare ctx jsonb := public.fluxo_ctx(p_conversa); v_pode jsonb; v_op uuid; v_rem jsonb; pa public.pre_agendamentos; v_vr jsonb;$q40$);
  if (length(n) - length(replace(n, $q41$  begin v_pode := public.klingo_pode_marcar(p_conversa);$q41$, ''))) <> length($q42$  begin v_pode := public.klingo_pode_marcar(p_conversa);$q42$) then raise exception 'particular-valor: trecho 2 de finalizar não encontrado ou repetido'; end if;
  n := replace(n, $q43$  begin v_pode := public.klingo_pode_marcar(p_conversa);$q43$, $q44$  -- particular-valor: recusou o valor = equipe avisada, nada é cadastrado no Klingo; sem preço = pendência da equipe responder o valor
  if public.particular_valor_ativo(p_conversa) then
    select f.dados -> 'valor_resp' into v_vr from public.conversa_fluxo f where f.conversa_id = p_conversa;
    if (v_vr ->> 'assin') is not distinct from public.particular_valor_assinatura(p_conversa) then
      if v_vr ->> 'resp' = 'recusado' then
        perform public.fluxo_dizer(p_conversa, public.fluxo_t('valor_recusado_equipe', ctx), jsonb_build_object('tipo', 'acompanhar'));
        perform public.fluxo_transferir(p_conversa, 'VALOR RECUSADO: o paciente viu o valor Particular (' || public.preco_brl((v_vr ->> 'total')::numeric) || ') e NÃO quis marcar. Nada foi cadastrado no Klingo. Conversar sobre outras opções.', 'media', false);
        return;
      elsif v_vr ->> 'resp' = 'quer_valor' then
        perform public.fluxo_finalizar_humano(p_conversa, 'PENDENTE: o paciente quer saber o VALOR do atendimento Particular (a API não trouxe o preço). Informar o valor aqui; só marcar se ele concordar.', 'media', 'valor_quer_equipe');
        return;
      elsif v_vr ->> 'resp' = 'dispensou' then
        perform public.fluxo_finalizar_humano(p_conversa, 'Particular sem preço na API; o paciente não pediu o valor agora. Marcação feita pela equipe.', 'baixa', 'valor_dispensou_equipe');
        return;
      end if;
    end if;
  end if;
  begin v_pode := public.klingo_pode_marcar(p_conversa);$q44$);
  execute n;
end $patch$;
