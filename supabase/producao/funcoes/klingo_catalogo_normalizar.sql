-- public.klingo_catalogo_normalizar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_catalogo_normalizar()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_p int := 0; v_u int := 0; v_e int := 0;
begin
  insert into public.klingo_profissional (id, nome, nome_norm, conselho, numero, uf, cbos, idade_max, subespecialidade, visto_em)
  select (p ->> 'id')::bigint, left(p ->> 'nome', 200), coalesce(public.norm_nome(p ->> 'nome'), ''), left(p ->> 'conselho', 20), left(p ->> 'numero', 30), left(p ->> 'uf', 4),
         coalesce((select array_agg(e ->> 'cbos') from jsonb_array_elements(case when jsonb_typeof(p -> 'especialidades') = 'array' then p -> 'especialidades' else '[]'::jsonb end) e where nullif(e ->> 'cbos', '') is not null), '{}'),
         (select max((e ->> 'paciente_idade_maxima')::int) from jsonb_array_elements(case when jsonb_typeof(p -> 'especialidades') = 'array' then p -> 'especialidades' else '[]'::jsonb end) e where (e ->> 'paciente_idade_maxima') ~ '^[0-9]+$'),
         left(p ->> 'subespecialidade', 120), now()
    from public.klingo_catalogo_cru c, jsonb_array_elements(c.dados) p
   where c.endpoint = '/profissionais' and jsonb_typeof(c.dados) = 'array' and (p ->> 'id') ~ '^[0-9]+$' and nullif(p ->> 'nome', '') is not null
  on conflict (id) do update set nome = excluded.nome, nome_norm = excluded.nome_norm, conselho = excluded.conselho, numero = excluded.numero, uf = excluded.uf, cbos = excluded.cbos,
    idade_max = excluded.idade_max, subespecialidade = excluded.subespecialidade, visto_em = now();
  get diagnostics v_p = row_count;
  insert into public.klingo_unidade_api (id, nome, cnes, visto_em)
  select (u ->> 'id')::int, left(u ->> 'nome', 200), left(u ->> 'cnes', 20), now()
    from public.klingo_catalogo_cru c, jsonb_array_elements(c.dados) u where c.endpoint = '/unidades' and jsonb_typeof(c.dados) = 'array' and (u ->> 'id') ~ '^[0-9]+$'
  on conflict (id) do update set nome = excluded.nome, cnes = excluded.cnes, visto_em = now();
  get diagnostics v_u = row_count;
  insert into public.klingo_exame_api (id, descr, cbos, classes, visto_em)
  select (x ->> 'id')::int, left(x ->> 'descr', 300), left(x #>> '{especialidade,cbos}', 12),
         coalesce((select array_agg(k) from jsonb_array_elements_text(case when jsonb_typeof(x -> 'classes') = 'array' then x -> 'classes' else '[]'::jsonb end) k), '{}'), now()
    from public.klingo_catalogo_cru c, jsonb_array_elements(c.dados) x where c.endpoint = '/agenda/exames' and jsonb_typeof(c.dados) = 'array' and (x ->> 'id') ~ '^[0-9]+$'
  on conflict (id) do update set descr = excluded.descr, cbos = excluded.cbos, classes = excluded.classes, visto_em = now();
  get diagnostics v_e = row_count;
  return jsonb_build_object('profissionais', v_p, 'unidades', v_u, 'exames', v_e);
end $function$;

