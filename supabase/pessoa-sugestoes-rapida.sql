-- FLUXOGRAMA: entrada (conversas dos últimos 120 dias) -> validação (pares com nome + exatamente 1 outra informação batendo, sem contradição) -> lógica (cada par é avaliado UMA vez, com as fichas já calculadas) -> saída (lista de sugestões que a equipe confirma ou recusa no painel)
-- DEPENDÊNCIAS: supabase/pessoa-unica.sql e supabase/pessoa-unica-correcao.sql (pessoa_ficha, pessoa_sinais, pessoa_nasc_parecida, nome_confere, conversa_grupo, conversa_grupo_recusa, pessoa_equipe)
-- ROLLBACK: reaplicar a definição de pessoa_sugestoes() de supabase/pessoa-unica.sql; drop function public.pessoa_sinais_fichas(jsonb, jsonb);
-- Motivo (09/11/2026): pessoa_sugestoes() levava ~4,7 s por chamada no painel e estourava o limite de 8 s (454 erros 500 no dia), saturando o banco e atrasando o resto do site.
--   A causa era recalcular a ficha das duas conversas e o cálculo de sinais várias vezes por par. Agora: ~60 ms.
-- Não muda o resultado: pessoa_sinais_fichas() é a mesma regra de pessoa_sinais(), recebendo as fichas prontas (conferido em 834 pares: 0 diferenças).
-- Não apaga nem move nada.

-- 1. Mesma regra de pessoa_sinais(), mas recebendo as duas fichas (jsonb) já calculadas.
create or replace function public.pessoa_sinais_fichas(a jsonb, b jsonb) returns jsonb
language plpgsql stable set search_path to '' as $$
declare s text[] := '{}'; k text[] := '{}'; v_aprox boolean := false;
begin
  if a is null or b is null or not public.nome_confere(a ->> 'nome', b ->> 'nome') then
    return jsonb_build_object('nome', false, 'sinais', '[]'::jsonb, 'conflitos', '[]'::jsonb, 'total', 0);
  end if;
  s := array['nome'];
  if a ->> 'fone' is not null and a ->> 'fone' = b ->> 'fone' then s := array_append(s, 'telefone'::text); end if;
  if a ->> 'email' is not null and a ->> 'email' = b ->> 'email' then s := array_append(s, 'email'::text); end if;
  if a ->> 'nasc' is not null and a ->> 'nasc' = b ->> 'nasc' then s := array_append(s, 'nascimento'::text); end if;
  if a ->> 'conta' is not null and a ->> 'conta' = b ->> 'conta' then s := array_append(s, 'conta'::text); end if;
  if a ->> 'nasc' is not null and b ->> 'nasc' is not null and a ->> 'nasc' <> b ->> 'nasc' then
    if public.pessoa_nasc_parecida(a ->> 'nasc', b ->> 'nasc') then v_aprox := true; else k := array_append(k, 'nascimento'::text); end if;
  end if;
  if a ->> 'conta' is not null and b ->> 'conta' is not null and a ->> 'conta' <> b ->> 'conta' then k := array_append(k, 'conta'::text); end if;
  if a ->> 'tipo' <> b ->> 'tipo' then k := array_append(k, 'tipo'::text); end if;
  return jsonb_build_object('nome', true, 'sinais', to_jsonb(s), 'conflitos', to_jsonb(k), 'total', cardinality(s), 'nascimento_parecido', v_aprox);
end $$;
revoke all on function public.pessoa_sinais_fichas(jsonb, jsonb) from public, anon, authenticated;

-- 2. Sugestões: a CTE "cand" é MATERIALIZED, então cada par é avaliado uma única vez.
create or replace function public.pessoa_sugestoes() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare v_out jsonb;
begin
  perform public.pessoa_equipe();
  with f as materialized (
    select c.id, public.pessoa_ficha(c.id) as j, c.atualizado_em from public.conversas c where c.criado_em > now() - interval '120 days'
  ), par as (
    select a.id as a, b.id as b from f a join f b on a.id < b.id and a.j ->> 'fone' = b.j ->> 'fone' and a.j ->> 'fone' is not null
    union select a.id, b.id from f a join f b on a.id < b.id and a.j ->> 'email' = b.j ->> 'email' and a.j ->> 'email' is not null
    union select a.id, b.id from f a join f b on a.id < b.id and a.j ->> 'conta' = b.j ->> 'conta' and a.j ->> 'conta' is not null
    union select a.id, b.id from f a join f b on a.id < b.id and a.j ->> 'nasc' = b.j ->> 'nasc' and a.j ->> 'nasc' is not null
  ), cand as materialized (
    select p.a, p.b, public.pessoa_sinais_fichas(fa.j, fb.j) as s, fa.j ->> 'nome' as nome_a, fb.j ->> 'nome' as nome_b,
           greatest(fa.atualizado_em, fb.atualizado_em) as ultima
    from par p join f fa on fa.id = p.a join f fb on fb.id = p.b
    where not exists (select 1 from public.conversa_grupo ga join public.conversa_grupo gb on gb.grupo_id = ga.grupo_id where ga.conversa_id = p.a and gb.conversa_id = p.b)
      and not exists (select 1 from public.conversa_grupo_recusa x where x.a = p.a and x.b = p.b)
  )
  select coalesce(jsonb_agg(jsonb_build_object('a', c.a, 'b', c.b, 'nome_a', c.nome_a, 'nome_b', c.nome_b, 'sinais', c.s -> 'sinais', 'total', c.s -> 'total') order by c.ultima desc), '[]'::jsonb)
    into v_out
  from cand c
  where (c.s ->> 'total')::int = 2 and jsonb_array_length(c.s -> 'conflitos') = 0;
  return v_out;
end $$;
revoke all on function public.pessoa_sugestoes() from public, anon;
grant execute on function public.pessoa_sugestoes() to authenticated;
