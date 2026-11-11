-- public.teste_ids(p_chave text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.teste_ids(p_chave text)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(array_agg(btrim(x)::uuid), '{}'::uuid[])
    from public.config c, unnest(string_to_array(c.valor, ',')) x
   where c.chave = p_chave and btrim(x) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$function$;

