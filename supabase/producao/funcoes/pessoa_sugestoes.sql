-- public.pessoa_sugestoes()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.pessoa_sugestoes()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    -- MATERIALIZED: cada par é avaliado uma única vez, usando as fichas já calculadas (antes refazia a ficha e o cálculo várias vezes por par).
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
end $function$;

