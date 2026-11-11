-- public.fila_segredo_ok(p_segredo text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fila_segredo_ok(p_segredo text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(p_segredo <> '' and p_segredo = public.fila_segredo_vault('fila_segredo'), false)
$function$;

