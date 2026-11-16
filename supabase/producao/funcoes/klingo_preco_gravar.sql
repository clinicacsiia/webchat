-- public.klingo_preco_gravar(p_linhas jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_preco_gravar(p_linhas jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb; n int := 0; v_val numeric;
begin
  for r in select * from jsonb_array_elements(case when jsonb_typeof(p_linhas) = 'array' then p_linhas else '[]'::jsonb end) loop
    if (r ->> 'id') ~ '^\d+$' and (r ->> 'plano') ~ '^\d+$' then
      v_val := case when (r ->> 'valor') ~ '^\d+(\.\d+)?$' and (r ->> 'valor')::numeric > 0 and (r ->> 'valor')::numeric < 100000 then (r ->> 'valor')::numeric else null end;
      insert into public.klingo_preco_api (procedimento_id, plano_id, valor, consultado_em)
      values ((r ->> 'id')::int, (r ->> 'plano')::int, v_val, now())
      on conflict (procedimento_id, plano_id) do update set valor = excluded.valor, consultado_em = excluded.consultado_em;
      n := n + 1;
    end if;
  end loop;
  return n;
end $function$;

