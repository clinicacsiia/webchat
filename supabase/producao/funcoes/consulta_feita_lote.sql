-- public.consulta_feita_lote(p_linhas jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.consulta_feita_lote(p_linhas jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb; n integer := 0; v integer;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then raise exception 'O lote precisa ser uma lista.'; end if;
  for r in select x from jsonb_array_elements(p_linhas) x loop
    if coalesce(r ->> 'm', '') = '' or coalesce(r ->> 'p', '') = '' or r ->> 'p' like 'n:%' or coalesce(btrim(r ->> 'q'), '') = ''
       or coalesce(r ->> 'd', '') !~ '^\d{4}-\d{2}-\d{2}' then continue; end if;
    insert into public.consulta_feita as c (marcacao_id, prontuario, profissional, procedimento, atendido_em)
    values (left(r ->> 'm', 40), left(r ->> 'p', 40), left(btrim(r ->> 'q'), 120), nullif(left(btrim(coalesce(r ->> 'x', '')), 200), ''), (left(r ->> 'd', 10))::date)
    on conflict (marcacao_id) do update set prontuario = excluded.prontuario, profissional = excluded.profissional, procedimento = excluded.procedimento,
      atendido_em = excluded.atendido_em, atualizado_em = now()
    where (c.prontuario, c.profissional, c.procedimento, c.atendido_em) is distinct from (excluded.prontuario, excluded.profissional, excluded.procedimento, excluded.atendido_em);
    get diagnostics v = row_count; n := n + v;
  end loop;
  return jsonb_build_object('gravadas', n);
end $function$;

