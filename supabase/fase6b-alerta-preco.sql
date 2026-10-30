-- Fase 6b: a IA não fala preço; o sistema só vigia o valor que o ATENDENTE informa.
--
--  * ia_catalogo deixa de entregar preços à IA (a IA nunca vê valor, então não tem como citar).
--  * Quando um atendente (mensagem com agente_id) escreve um valor em reais no chat, o sistema compara com o valor de
--    referência do catálogo (exames do pedido + plano) e, se estiver a mais de 10% fora, grava um alerta.
--  * O alerta fica em alerta_preco, que só administrador e atendente leem (RLS). O paciente nunca vê: nada é escrito em
--    mensagens, e o chat do paciente só lê mensagens.
--
-- Só compara quando TODOS os exames do pedido têm preço de confiança alta ou média para o plano informado; senão não há
-- como julgar e nada é gravado. Aceita o valor de um exame, o valor multiplicado pela quantidade ou a soma de todos.
-- Aditivo e seguro para rodar de novo. Independente do fase6-unidade-e-medico.sql (pode rodar antes ou depois).

-- ===== 1. Valores em reais de um texto =====
-- "R$ 1.234,56", "R$180", "R$ 80,5", "300 reais" -> {1234.56, 180, 80.5, 300}
create or replace function public.valores_em_reais(p_texto text) returns numeric[]
language sql immutable set search_path to '' as $$
  select coalesce(array_agg(v order by ord), '{}'::numeric[]) from (
    select ord, replace(replace(m[1], '.', ''), ',', '.')::numeric as v
    from regexp_matches(coalesce(p_texto, ''), 'R\$\s*([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?|[0-9]+(?:,[0-9]{1,2})?)', 'g') with ordinality as t(m, ord)
    union all
    select 1000 + ord, replace(replace(m[1], '.', ''), ',', '.')::numeric
    from regexp_matches(coalesce(p_texto, ''), '([0-9]{1,3}(?:\.[0-9]{3})+(?:,[0-9]{1,2})?|[0-9]+(?:,[0-9]{1,2})?)\s*reais', 'gi') with ordinality as t(m, ord)
  ) x
$$;

-- ===== 2. Alertas (só a equipe lê) =====
create table if not exists public.alerta_preco (
  id bigint generated always as identity primary key,
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  mensagem_id bigint references public.mensagens (id) on delete set null,
  agente_id uuid,
  valor_informado numeric(12,2) not null,
  tipo text not null check (tipo in ('abaixo', 'acima')),
  referencia jsonb not null,            -- { plano, candidatos: [{rotulo, de, ate}] }
  criado_em timestamptz not null default now(),
  conferido_em timestamptz,
  conferido_por uuid
);
create index if not exists alerta_preco_aberto on public.alerta_preco (conversa_id) where conferido_em is null;
alter table public.alerta_preco enable row level security;
comment on table public.alerta_preco is 'Valor que o atendente informou no chat e que ficou fora (10% ou mais) do valor de referência do catálogo. Só administrador e atendente leem; o paciente nunca vê. Sem dado do paciente além da conversa.';
do $p$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'alerta_preco' and policyname = 'alerta_preco_select') then
    create policy alerta_preco_select on public.alerta_preco for select to authenticated
      using ((select public.papel_atual()) = any (array['admin', 'atendente']));
  end if;
end $p$;

-- ===== 3. Valor de referência do pedido =====
-- Devolve { plano, candidatos: [...] } ou null quando não dá para julgar.
create or replace function public.preco_referencia_pedido(p_conversa uuid) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_plano text; v_n int; v_com int; r jsonb;
begin
  select pa.plano into v_plano from public.pre_agendamentos pa where pa.conversa_id = p_conversa;
  if nullif(btrim(coalesce(v_plano, '')), '') is null then return null; end if;

  with itens as (
    select i.procedimento_id, coalesce(max(i.procedimento), '') as nome, sum(i.quantidade)::int as qtd
    from public.pre_agendamento_itens i
    where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null
    group by i.procedimento_id),
  ref as (
    select it.procedimento_id, it.nome, it.qtd,
           min(coalesce(pr.valor_min, pr.valor)) as lo, max(coalesce(pr.valor_max, pr.valor)) as hi
    from itens it
    join public.catalogo_preco pr on pr.procedimento_id = it.procedimento_id and pr.status = 'ativo' and pr.confianca in ('alta', 'media')
     and ((upper(extensions.unaccent(v_plano)) like 'PARTICULAR%' and pr.fonte = 'particular')
       or (pr.fonte = 'convenio' and (strpos(upper(extensions.unaccent(pr.operadora)), upper(extensions.unaccent(v_plano))) > 0
                                   or strpos(upper(extensions.unaccent(v_plano)), upper(extensions.unaccent(pr.operadora))) > 0)))
    group by it.procedimento_id, it.nome, it.qtd)
  select (select count(*) from itens), (select count(*) from ref),
    (select jsonb_agg(c) from (
       select jsonb_build_object('rotulo', ref.nome, 'de', ref.lo, 'ate', ref.hi) as c from ref
       union all
       select jsonb_build_object('rotulo', ref.nome || ' (' || ref.qtd || ' unidades)', 'de', ref.lo * ref.qtd, 'ate', ref.hi * ref.qtd) from ref where ref.qtd > 1
       union all
       select jsonb_build_object('rotulo', 'Total dos exames do pedido', 'de', sum(ref.lo * ref.qtd), 'ate', sum(ref.hi * ref.qtd)) from ref having count(*) > 1) q)
  into v_n, v_com, r;
  if v_n = 0 or v_com < v_n or r is null then return null; end if;
  return jsonb_build_object('plano', v_plano, 'candidatos', r);
end $$;
revoke all on function public.preco_referencia_pedido(uuid) from public, anon, authenticated;
grant execute on function public.preco_referencia_pedido(uuid) to service_role;

-- ===== 4. Gatilho: mensagem de atendente com valor em reais =====
create or replace function public.mensagens_conferir_preco_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
declare v_ref jsonb; v_tol numeric; v numeric; k int := 0; c jsonb; v_perto jsonb; v_dist numeric; v_melhor numeric; v_ok boolean;
begin
  if new.autor <> 'agente' or new.agente_id is null or new.texto is null or new.texto !~* '(R\$|reais)' then return new; end if;
  begin
    v_ref := public.preco_referencia_pedido(new.conversa_id);
    if v_ref is null then return new; end if;
    v_tol := coalesce(nullif((select valor from public.config where chave = 'alerta_preco_tolerancia_pct'), '')::numeric, 10) / 100.0;
    foreach v in array public.valores_em_reais(new.texto) loop
      k := k + 1; exit when k > 3;
      if v < 5 then continue; end if;
      v_ok := false; v_perto := null; v_melhor := null;
      for c in select * from jsonb_array_elements(v_ref -> 'candidatos') loop
        if v >= (c ->> 'de')::numeric * (1 - v_tol) and v <= (c ->> 'ate')::numeric * (1 + v_tol) then v_ok := true; exit; end if;
        v_dist := least(abs(v - (c ->> 'de')::numeric), abs(v - (c ->> 'ate')::numeric));
        if v_melhor is null or v_dist < v_melhor then v_melhor := v_dist; v_perto := c; end if;
      end loop;
      if v_ok then continue; end if;
      insert into public.alerta_preco (conversa_id, mensagem_id, agente_id, valor_informado, tipo, referencia)
      values (new.conversa_id, new.id, new.agente_id, v,
              case when v < (v_perto ->> 'de')::numeric * (1 - v_tol) then 'abaixo' else 'acima' end, v_ref);
    end loop;
  exception when others then
    raise warning 'mensagens_conferir_preco_trg: %', sqlerrm;   -- nunca atrapalha o atendimento
  end;
  return new;
end $$;
create or replace trigger mensagens_conferir_preco after insert on public.mensagens
  for each row execute function public.mensagens_conferir_preco_trg();
revoke all on function public.mensagens_conferir_preco_trg() from public, anon, authenticated;   -- função de gatilho: ninguém chama direto

-- ===== 5. A equipe marca o alerta como conferido =====
create or replace function public.alerta_preco_conferir(p_conversa uuid) returns integer
language plpgsql security definer set search_path to '' as $$
declare n integer;
begin
  if (select public.papel_atual()) is null or (select public.papel_atual()) not in ('admin', 'atendente') then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  update public.alerta_preco set conferido_em = now(), conferido_por = auth.uid() where conversa_id = p_conversa and conferido_em is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.alerta_preco_conferir(uuid) from public, anon;
grant execute on function public.alerta_preco_conferir(uuid) to authenticated;

-- ===== 6. A IA deixa de receber preço =====
do $do$
declare v_def text; v_new text;
begin
  v_def := pg_get_functiondef('public.ia_catalogo(text,uuid)'::regprocedure);
  if position('''precos'', v_precos' in v_def) > 0 then
    v_new := replace(v_def, '''precos'', v_precos', '''precos'', ''[]''::jsonb');
    if v_new = v_def then raise exception 'ia_catalogo: trecho não encontrado.'; end if;
    execute v_new;
  end if;
end $do$;
