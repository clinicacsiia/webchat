-- public.consulta_atendida_lote(p_linhas jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.consulta_atendida_lote(p_linhas jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb; v_cpf text; v_nasc date; v_dia date; v_chave text; v_q text; n integer := 0; v integer;
begin
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then raise exception 'O lote precisa ser uma lista.'; end if;
  for r in select x from jsonb_array_elements(p_linhas) x loop
    v_cpf := regexp_replace(coalesce(r ->> 'c', ''), '\D', '', 'g');
    v_q := left(btrim(coalesce(r ->> 'q', '')), 120);
    if not public.fluxo_cpf_ok(v_cpf) or v_q = '' or coalesce(r ->> 'n', '') !~ '^\d{4}-\d{2}-\d{2}$' or coalesce(r ->> 'd', '') !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;
    v_nasc := (r ->> 'n')::date; v_dia := (r ->> 'd')::date;
    v_chave := public.klingo_hash(v_cpf || '|' || v_nasc::text);    -- a mesma conta de klingo_dados_conversa / klingo_identidade
    insert into public.consulta_feita (marcacao_id, prontuario, profissional, procedimento, atendido_em, chave)
    values ('a:' || left(md5(v_chave || '|' || coalesce(public.norm_nome(v_q), '') || '|' || v_dia::text), 30), nullif(left(btrim(coalesce(r ->> 'p', '')), 40), ''), v_q, null, v_dia, v_chave)
    on conflict (marcacao_id) do nothing;
    get diagnostics v = row_count; n := n + v;
  end loop;
  return jsonb_build_object('gravadas', n);
end $function$;

