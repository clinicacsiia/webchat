-- public.ocr_exame_json(p_id integer, p_lado text, p_linha text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ocr_exame_json(p_id integer, p_lado text, p_linha text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object('id', x.id, 'nome', x.nome, 'modalidade', x.modalidade, 'regiao', reg.codigo, 'regiao_nome', reg.nome,
           'tem_lado', coalesce(reg.tem_lado, false), 'bilateral', x.nome ~* 'BILATERAL', 'lado', nullif(p_lado, 'N'), 'linha', left(p_linha, 120))
  from public.fluxo_exames x
  left join lateral (select g.codigo, g.nome, g.tem_lado from public.catalogo_regiao g
                     where regexp_replace(public.norm_nome(x.nome), 'NAO INCLUI.*$', '') ~ g.padrao order by g.ordem limit 1) reg on true
  where x.id = p_id
$function$;

