-- public.klingo_catalogo_cru_gravar(p_endpoint text, p_dados jsonb, p_status integer)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_catalogo_cru_gravar(p_endpoint text, p_dados jsonb, p_status integer)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  insert into public.klingo_catalogo_cru (endpoint, dados, status, itens, atualizado_em)
  values (left(p_endpoint, 200), p_dados, p_status, case when jsonb_typeof(p_dados) = 'array' then jsonb_array_length(p_dados) end, now())
  on conflict (endpoint) do update set dados = excluded.dados, status = excluded.status, itens = excluded.itens, atualizado_em = now()
$function$;

