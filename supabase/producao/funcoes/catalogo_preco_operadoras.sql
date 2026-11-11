-- public.catalogo_preco_operadoras()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.catalogo_preco_operadoras()
 RETURNS TABLE(operadora_id integer, atualizado_em timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p.operadora_id, max(p.visto_em) from public.catalogo_preco p where p.fonte = 'convenio' group by p.operadora_id;
$function$;

