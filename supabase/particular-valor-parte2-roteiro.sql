-- FLUXOGRAMA: ver particular-valor-parte1-base.sql (passo novo `valor` para paciente Particular: valor da API em destaque; concordou = marca; recusou ou sem preço = equipe, sem cadastrar no Klingo)
-- Versão 1.0 — 16/11/2026 / Mudança: o roteiro (fluxo_proximo), a leitura de "sim/não" no texto livre (fluxo_ler_texto) e a trava da marcação automática (klingo_pode_marcar).
-- Cada bloco abaixo LÊ a definição que está no banco (pg_get_functiondef), troca só os trechos marcados (erro e nada aplicado se algum trecho não existir exatamente uma vez) e recria a função. Assim não pisa em mudanças de outras sessões. Rodar de novo não faz nada (marca "-- particular-valor").
-- Com particular_valor_modo = nao o comportamento é idêntico ao anterior.
-- ROLLBACK: recriar as funções a partir de supabase/producao/funcoes/ (versão anterior no git) ou desligar a chave particular_valor_modo.

-- ===== Parte 2 =====
do $patch$
declare d text; n text; sig regprocedure := 'public.fluxo_proximo(uuid)'::regprocedure;
begin
  d := pg_get_functiondef(sig);
  if position('-- particular-valor' in d) > 0 then return; end if;   -- já aplicado
  n := d;
  if (length(n) - length(replace(n, $q1$  if not coalesce((d ->> 'confirmado')::boolean, false) then return 'confirmar'; end if;
  return 'pronto';$q1$, ''))) <> length($q2$  if not coalesce((d ->> 'confirmado')::boolean, false) then return 'confirmar'; end if;
  return 'pronto';$q2$) then raise exception 'particular-valor: trecho 1 de proximo não encontrado ou repetido'; end if;
  n := replace(n, $q3$  if not coalesce((d ->> 'confirmado')::boolean, false) then return 'confirmar'; end if;
  return 'pronto';$q3$, $q4$  if not coalesce((d ->> 'confirmado')::boolean, false) then return 'confirmar'; end if;
  -- particular-valor: Particular só segue depois de ver o valor e responder (a resposta vale só para este plano + exames)
  if public.particular_valor_ativo(p_conversa) and (d -> 'valor_resp' ->> 'assin') is distinct from public.particular_valor_assinatura(p_conversa) then return 'valor'; end if;
  return 'pronto';$q4$);
  execute n;
end $patch$;

do $patch$
declare d text; n text; sig regprocedure := 'public.fluxo_ler_texto(uuid,text,text)'::regprocedure;
begin
  d := pg_get_functiondef(sig);
  if position('-- particular-valor' in d) > 0 then return; end if;   -- já aplicado
  n := d;
  if (length(n) - length(replace(n, $q5$  when 'confirmar' then
    if sim then return '"ok"'; end if;
$q5$, ''))) <> length($q6$  when 'confirmar' then
    if sim then return '"ok"'; end if;
$q6$) then raise exception 'particular-valor: trecho 1 de ler_texto não encontrado ou repetido'; end if;
  n := replace(n, $q7$  when 'confirmar' then
    if sim then return '"ok"'; end if;
$q7$, $q8$  when 'confirmar' then
    if sim then return '"ok"'; end if;
  when 'valor' then   -- particular-valor
    if sim then return '"sim"'; end if;
    if nao then return '"nao"'; end if;
$q8$);
  execute n;
end $patch$;

do $patch$
declare d text; n text; sig regprocedure := 'public.klingo_pode_marcar(uuid)'::regprocedure;
begin
  d := pg_get_functiondef(sig);
  if position('-- particular-valor' in d) > 0 then return; end if;   -- já aplicado
  n := d;
  if (length(n) - length(replace(n, $q9$  d := public.klingo_dados_conversa(p_conversa);
  if (d ->> 'n_procedimentos')::int <> 1$q9$, ''))) <> length($q10$  d := public.klingo_dados_conversa(p_conversa);
  if (d ->> 'n_procedimentos')::int <> 1$q10$) then raise exception 'particular-valor: trecho 1 de pode_marcar não encontrado ou repetido'; end if;
  n := replace(n, $q11$  d := public.klingo_dados_conversa(p_conversa);
  if (d ->> 'n_procedimentos')::int <> 1$q11$, $q12$  -- particular-valor: paciente Particular só é cadastrado no Klingo se viu e ACEITOU o valor
  if public.particular_valor_ativo(p_conversa) and not coalesce((select f.dados -> 'valor_resp' ->> 'resp' = 'aceito' and f.dados -> 'valor_resp' ->> 'assin' = public.particular_valor_assinatura(p_conversa)
       from public.conversa_fluxo f where f.conversa_id = p_conversa), false) then
    return jsonb_build_object('ok', false, 'motivo', 'valor_nao_aceito', 'detalhe', 'o paciente Particular não aceitou (ou não viu) o valor');
  end if;
  d := public.klingo_dados_conversa(p_conversa);
  if (d ->> 'n_procedimentos')::int <> 1$q12$);
  execute n;
end $patch$;
