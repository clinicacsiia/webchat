-- public.pmarc_lote(p_linhas jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_lote(p_linhas jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb; v_lidas integer := 0; v_novas integer := 0; v_mudou integer := 0; v_n integer; v_nova boolean;
begin
  if not public.pmarc_ligada() then return jsonb_build_object('ligada', false, 'lidas', 0); end if;
  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' then raise exception 'O lote precisa ser uma lista.' using errcode = '22023'; end if;
  for r in select x from jsonb_array_elements(p_linhas) x loop
    if coalesce(btrim(r ->> 'p'), '') = '' then continue; end if;
    v_nova := null;
    insert into public.pmarc_pessoa as pp (chave, nome, celular, telefone, primeira_vez)
    values (left(btrim(r ->> 'p'), 60), nullif(left(btrim(coalesce(r ->> 'n', '')), 120), ''), public.pmarc_telefone(r ->> 'c'), public.pmarc_telefone(r ->> 't'),
            case upper(btrim(coalesce(r ->> 'v', ''))) when 'S' then true when 'N' then false end)
    on conflict (chave) do update set
      nome = coalesce(excluded.nome, pp.nome), celular = coalesce(excluded.celular, pp.celular), telefone = coalesce(excluded.telefone, pp.telefone),
      primeira_vez = coalesce(excluded.primeira_vez, pp.primeira_vez), atualizado_em = now()
    where (pp.nome, pp.celular, pp.telefone, pp.primeira_vez) is distinct from
          (coalesce(excluded.nome, pp.nome), coalesce(excluded.celular, pp.celular), coalesce(excluded.telefone, pp.telefone), coalesce(excluded.primeira_vez, pp.primeira_vez))
    returning (xmax = 0) into v_nova;
    get diagnostics v_n = row_count;
    v_mudou := v_mudou + v_n;
    if v_nova then v_novas := v_novas + 1; end if;
    v_lidas := v_lidas + 1;
  end loop;
  return jsonb_build_object('ligada', true, 'lidas', v_lidas, 'novas', v_novas, 'alteradas', v_mudou);
end $function$;

