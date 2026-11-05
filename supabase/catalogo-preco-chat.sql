-- Previsão de preço no chat (liga com o botão "Chat informa" do cardápio, ver catalogo-preco-revisao.sql).
--
-- Quando o paciente pergunta "quanto custa", o motor (fluxo_avancar) usa preco_previsao_chat(conversa):
--   * devolve a mensagem com a previsão SÓ se TODOS os exames do pedido têm preço ligado para o plano do paciente
--     (Particular, ou a operadora que bate com o plano) e se os valores ligados não se contradizem;
--   * em qualquer outra situação devolve null e o motor segue com o texto de sempre ("quem informa o valor é o atendente").
-- Nada de paciente sai daqui: só o texto com exames, plano e valores. Qualquer erro vira null (o chat nunca trava por causa disso).
-- Ordem: depois de catalogo-preco-revisao.sql. Seguro para rodar de novo.

create or replace function public.preco_brl(v numeric) returns text
language sql immutable set search_path to '' as $$
  select 'R$ ' || regexp_replace(trunc(round(v, 2))::text, '(\d)(?=(\d{3})+$)', '\1.', 'g') || ',' || lpad((round((round(v, 2) - trunc(round(v, 2))) * 100))::int::text, 2, '0')
$$;

insert into public.fluxo_texto (chave, texto, descricao) values
 ('preco_previsao', E'Previsão de valor ({plano}):\n{itens}\n{total}Atenção: é só uma previsão. O valor final e a forma de pagamento são confirmados pelo atendente.',
  'Resposta a "quanto custa" quando o preço foi ligado no cardápio. {plano}, {itens} e {total} são preenchidos pelo sistema.')
on conflict (chave) do nothing;

-- Quantas vezes o preço vale quando o paciente pede "os dois lados" (lado = 'A'):
--   exame BILATERAL já inclui os dois lados (1); exame UNILATERAL ou "POR ARTICULAÇÃO" cobra e laudoa cada lado (2); nome sem essa informação: null (o atendente confirma).
create or replace function public.preco_fator_lado(p_lado text, p_nome text) returns integer
language sql immutable set search_path to '' as $$
  select case
    when p_lado is distinct from 'A' then 1
    when public.norm_chave(p_nome) ~ 'BILATERAL' then 1
    when public.norm_chave(p_nome) ~ 'UNILATERAL|POR ARTICULACAO' then 2
    else null end
$$;

create or replace function public.preco_previsao_chat(p_conversa uuid) returns text
language plpgsql stable security definer set search_path to '' as $$
declare
  v_plano text; v_pn text; v_part boolean;
  r record; v_lo numeric; v_hi numeric; v_k int;
  v_n int := 0; v_total numeric := 0; v_multi boolean := false; v_linhas text := '';
begin
  select pa.plano into v_plano from public.pre_agendamentos pa where pa.conversa_id = p_conversa order by pa.atualizado_em desc limit 1;
  v_pn := public.norm_chave(v_plano);
  if v_pn is null then return null; end if;
  v_part := v_pn like 'PARTICULAR%';
  if not v_part and length(v_pn) < 3 then return null; end if;

  if exists (select 1 from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is null) then return null; end if;

  for r in
    select i.procedimento_id, coalesce(max(i.procedimento), '') as nome,
           greatest(sum(coalesce(i.quantidade, 1) * coalesce(public.preco_fator_lado(i.lado, p.nome), 1)), 1)::int as qtd,
           bool_or(i.lado = 'A' and public.preco_fator_lado(i.lado, p.nome) = 2) as dois_lados,
           bool_or(i.lado = 'A' and public.preco_fator_lado(i.lado, p.nome) is null) as lado_duvida
      from public.pre_agendamento_itens i
      join public.catalogo_procedimento p on p.id = i.procedimento_id
     where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null
     group by i.procedimento_id order by min(i.id)
  loop
    if r.lado_duvida then return null; end if;
    select min(rv.valor), max(rv.valor), count(*) into v_lo, v_hi, v_k
      from public.catalogo_preco_revisao rv
     where rv.procedimento_id = r.procedimento_id and rv.ligado
       and ((v_part and rv.opn = 'PARTICULAR')
         or (not v_part and rv.opn <> 'PARTICULAR' and (strpos(v_pn, rv.opn) > 0 or strpos(rv.opn, v_pn) > 0)));
    if v_k = 0 or v_lo is distinct from v_hi then return null; end if;
    v_n := v_n + 1; v_total := v_total + v_lo * r.qtd;
    if r.qtd > 1 then v_multi := true; end if;
    v_linhas := v_linhas || '• ' || r.nome
      || case when r.dois_lados then ' (dois lados, ' || r.qtd || 'x ' || public.preco_brl(v_lo) || ')' when r.qtd > 1 then ' (' || r.qtd || 'x ' || public.preco_brl(v_lo) || ')' else '' end
      || ': ' || public.preco_brl(v_lo * r.qtd) || E'\n';
  end loop;
  if v_n = 0 then return null; end if;

  return public.fluxo_t('preco_previsao', jsonb_build_object('plano', btrim(v_plano), 'itens', rtrim(v_linhas, E'\n'),
           'total', case when v_n > 1 or v_multi then E'Total previsto: ' || public.preco_brl(v_total) || E'\n' else '' end));
exception when others then
  return null;
end $$;
revoke all on function public.preco_previsao_chat(uuid) from public, anon, authenticated;
grant execute on function public.preco_previsao_chat(uuid) to service_role;

-- O motor passa a tentar a previsão antes do texto padrão. Troca uma única linha da função viva, sem reescrever o resto.
-- Se a linha já foi trocada (ou o texto mudou), não faz nada.
do $p$
declare d text; velho text := 'v_prefixo := public.fluxo_t(''preco'', ctx); v_prox := v_passo;'; novo text := 'v_prefixo := coalesce(public.preco_previsao_chat(p_conversa), public.fluxo_t(''preco'', ctx)); v_prox := v_passo;';
begin
  d := pg_get_functiondef('public.fluxo_avancar(uuid,jsonb)'::regprocedure);
  if position(velho in d) = 0 then
    raise notice 'fluxo_avancar: trecho não encontrado (já trocado ou diferente); nada a fazer.';
    return;
  end if;
  execute replace(d, velho, novo);
end $p$;

-- A conferência do valor que o atendente digita também conta os dois lados (senão cobrar certo geraria alerta falso).
do $p$
declare d text;
  velho text := 'sum(i.quantidade)::int as qtd';
  novo text := 'sum(i.quantidade * coalesce(public.preco_fator_lado(i.lado, (select p2.nome from public.catalogo_procedimento p2 where p2.id = i.procedimento_id)), 1))::int as qtd';
begin
  d := pg_get_functiondef('public.preco_referencia_pedido(uuid)'::regprocedure);
  if position(velho in d) = 0 then raise notice 'preco_referencia_pedido: trecho não encontrado; nada a fazer.'; return; end if;
  execute replace(d, velho, novo);
end $p$;
