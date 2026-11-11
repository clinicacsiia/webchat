-- public.org_nivel_de(p_agente uuid, p_papel text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.org_nivel_de(p_agente uuid, p_papel text)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when p_papel = 'admin' then 'ti'
    else (select m.funcao from public.org_membro m
           where m.agente_id = p_agente and m.ativo and (m.fim is null or m.fim >= current_date)
           order by array_position(array['ti', 'gerente', 'supervisor', 'atendente'], m.funcao) limit 1)
  end
$function$;

