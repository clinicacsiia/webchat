-- public.ocr_chave(t text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.ocr_chave(t text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select nullif(btrim(regexp_replace(regexp_replace(public.fluxo_norm_exame(left(coalesce(t, ''), 200)),
    '\m(DIREITO|DIREITA|ESQUERDO|ESQUERDA|DIR|ESQ|BILATERAL|AMBOS|LADO|LADOS|SOLICITO|SOLICITACAO|PEDIDO|REALIZAR|FAVOR|EXAME|EXAMES|\d+)\M', ' ', 'g'),
    '\s+', ' ', 'g')), '')
$function$;

