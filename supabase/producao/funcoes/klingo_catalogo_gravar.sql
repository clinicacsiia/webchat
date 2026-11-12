-- public.klingo_catalogo_gravar(p jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_catalogo_gravar(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_c integer := 0; v_e integer := 0;
begin
  if jsonb_typeof(p -> 'convenios') = 'array' then
    insert into public.klingo_convenio (plano_id, convenio_id, convenio, plano, convenio_norm, padrao, visto_em)
    select (pl ->> 'id')::integer, (c ->> 'id')::integer, left(c ->> 'nome', 200), left(coalesce(pl ->> 'nome', ''), 200), coalesce(public.norm_nome(c ->> 'nome'), ''),
           coalesce(public.norm_nome(pl ->> 'nome') = public.norm_nome(c ->> 'nome'), false), now()
      from jsonb_array_elements(p -> 'convenios') c, jsonb_array_elements(case when jsonb_typeof(c -> 'planos') = 'array' then c -> 'planos' else '[]'::jsonb end) pl
     where (pl ->> 'id') ~ '^[0-9]+$' and (c ->> 'id') ~ '^[0-9]+$' and nullif(c ->> 'nome', '') is not null
    on conflict (plano_id) do update set convenio_id = excluded.convenio_id, convenio = excluded.convenio, plano = excluded.plano,
      convenio_norm = excluded.convenio_norm, padrao = excluded.padrao, visto_em = now();
    get diagnostics v_c = row_count;
  end if;
  if jsonb_typeof(p -> 'especialidades') = 'array' then
    insert into public.klingo_especialidade (cbos, nome, codigo, procedimentos, atualizado_em)
    select e ->> 'cbos', left(e ->> 'nome', 120), left(e ->> 'codigo', 20),
           coalesce((select array_agg(x::integer) from jsonb_array_elements_text(case when jsonb_typeof(e -> 'procedimentos') = 'array' then e -> 'procedimentos' else '[]'::jsonb end) x where x ~ '^[0-9]+$'), '{}'), now()
      from jsonb_array_elements(p -> 'especialidades') e where (e ->> 'cbos') ~ '^[0-9]+$'
    on conflict (cbos) do update set nome = excluded.nome, codigo = excluded.codigo, procedimentos = excluded.procedimentos, atualizado_em = now();
    get diagnostics v_e = row_count;
  end if;
  return jsonb_build_object('planos', v_c, 'especialidades', v_e, 'mapa', public.klingo_plano_mapear_auto());
end $function$;

