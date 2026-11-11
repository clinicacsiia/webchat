-- public.pessoa_avisos_data()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.pessoa_avisos_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v jsonb;
begin
  perform public.pessoa_equipe();
  with f as materialized (select c.id, public.pessoa_ficha(c.id) as j from public.conversas c where c.criado_em > now() - interval '120 days'),
  par as (
    select a.id as a, b.id as b, a.j ->> 'nome' as nome, a.j ->> 'nasc' as na, b.j ->> 'nasc' as nb
      from f a join f b on a.id < b.id
     where a.j ->> 'nasc' is not null and b.j ->> 'nasc' is not null and a.j ->> 'nasc' <> b.j ->> 'nasc'
       and a.j ->> 'fone' is not null and a.j ->> 'fone' = b.j ->> 'fone'
       and a.j ->> 'email' is not null and a.j ->> 'email' = b.j ->> 'email'
       and a.j ->> 'tipo' = b.j ->> 'tipo' and public.nome_confere(a.j ->> 'nome', b.j ->> 'nome')
       and not exists (select 1 from public.conversa_grupo_recusa x where x.a = least(a.id, b.id) and x.b = greatest(a.id, b.id) and x.por is not null))
  select coalesce(jsonb_agg(jsonb_build_object('nome', q.nome, 'nasc_a', q.na, 'nasc_b', q.nb, 'parecida', public.pessoa_nasc_parecida(q.na, q.nb),
           'ids_a', q.ids_a, 'ids_b', q.ids_b) order by q.nome), '[]'::jsonb) into v
    from (select min(nome) as nome, na, nb, array_agg(distinct a) as ids_a, array_agg(distinct b) as ids_b from par group by na, nb) q;
  return v;
end $function$;

