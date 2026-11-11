-- public.chat_exames_buscar(p_conversa uuid, p_token text, p_termo text, p_ocr boolean)
-- Pode executar: anon, authenticated, service_role (PUBLIC)
CREATE OR REPLACE FUNCTION public.chat_exames_buscar(p_conversa uuid, p_token text, p_termo text, p_ocr boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_linhas text[]; l text; t text; v_mods text[]; v_regs text[]; v_lado text; r jsonb := '[]'::jsonb; v_parte jsonb; v_tok text[]; v_b int[]; n int := 0;
begin
  perform public.chat_valida(p_conversa, p_token);
  v_linhas := case when p_ocr then (select array_agg(x) from (select btrim(x) x from regexp_split_to_table(left(coalesce(p_termo, ''), 4000), '[\n;]+') x) q where length(x) >= 4)
                   else array[left(coalesce(p_termo, ''), 120)] end;
  foreach l in array coalesce(v_linhas, array['']) loop
    exit when n >= 12;
    t := public.fluxo_norm_exame(l);
    v_mods := array_remove(array[case when t ~ '\mRM\M' then 'RM' end, case when t ~ '\mTC\M' then 'TC' end, case when t ~ '\mUS\M|DOPPLER' then 'US' end,
                                 case when t ~ '\mRX\M' then 'RX' end, case when t ~ 'MAMOGRAF' then 'MAMO' end, case when t ~ 'DENSITOMETR' then 'DENSITO' end], null);
    select array_agg(g.codigo order by g.ordem) into v_regs from public.catalogo_regiao g
     where t <> '' and t ~ ('(' || split_part(g.padrao, '|^(?!', 1) || ')');
    v_lado := case when t ~ '\mBILATERA|\mAMBOS\M|\mDOIS LADOS' then 'A' when t ~ '\mDIREIT' then 'D' when t ~ '\mESQUERD' then 'E' end;
    v_tok := array(select w from unnest(string_to_array(t, ' ')) w where length(w) >= 2 and w !~ '^\d+$'
                   and w !~ '^(DIREITO|DIREITA|ESQUERDO|ESQUERDA|BILATERAL|AMBOS|LADO|LADOS|DOIS|EXAME|EXAMES|SOLICITO|SOLICITACAO|PEDIDO|FAVOR|REALIZAR|FAZER|QUERO|PRECISO|UM|UMA)$');
    select coalesce(array_agg(x.id), '{}') into v_b from public.fluxo_exames x
     where cardinality(v_tok) > 0 and (cardinality(v_mods) = 0 or x.modalidade = any(v_mods))
       and coalesce((select bool_and(x.chave ~ ('\m' || w)) from unnest(v_tok) w where w !~ '^(RM|TC|US|RX)$' or cardinality(v_mods) = 0), false);
    with cand as (
      select x.id, x.nome, x.modalidade, null::text as regiao, x.demanda, 0 as fonte from public.fluxo_exames x where x.id = any(v_b)
      union all
      select x.id, x.nome, x.modalidade, g.codigo, x.demanda, 1
      from public.fluxo_exames x join public.catalogo_regiao g on g.codigo = any(v_regs) and x.chave_reg ~ g.padrao
      where cardinality(v_regs) > 0 and (cardinality(v_mods) > 0 or cardinality(v_b) = 0)
        and x.modalidade = any(case when cardinality(v_mods) > 0 then v_mods else array['RM','TC','US','RX'] end)
      union all
      select x.id, x.nome, x.modalidade, null, x.demanda, 3 from public.fluxo_exames x
      where not p_ocr and cardinality(v_tok) = 0 and coalesce(cardinality(v_regs), 0) = 0 and x.modalidade <> 'OUTRO' and x.demanda > 0
    ), um as (
      select distinct on (c.id) c.* from cand c order by c.id, c.fonte
    ), lim as (
      select u.*, row_number() over (order by u.fonte, u.demanda desc, u.nome) as ord from um u
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'nome', x.nome, 'modalidade', x.modalidade, 'regiao', reg.codigo, 'regiao_nome', reg.nome,
             'tem_lado', coalesce(reg.tem_lado, false), 'bilateral', x.nome ~* 'BILATERAL', 'lado', v_lado, 'linha', case when p_ocr then left(l, 120) end,
             'sugerido', p_ocr and x.ord = 1) order by x.ord), '[]'::jsonb) into v_parte
    from lim x
    left join lateral (select g.codigo, g.nome, g.tem_lado from public.catalogo_regiao g
                       where g.codigo = x.regiao or (x.regiao is null and regexp_replace(public.norm_nome(x.nome), 'NAO INCLUI.*$', '') ~ g.padrao)
                       order by (g.codigo = x.regiao) desc, g.ordem limit 1) reg on true
    where x.ord <= case when p_ocr then 3 else 24 end;
    r := r || v_parte; n := n + 1;
  end loop;
  return r;
end $function$;

