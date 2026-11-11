-- public.jornada_equipe()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_equipe()
 RETURNS TABLE(id uuid, nome text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or not public.jornada_pode() then
    raise exception 'Sem permissão para a Jornada.';
  end if;
  return query select a.id, public.jornada_nome_de(a.id) from public.agentes a where a.ativo and a.papel in ('admin', 'atendente') order by 2;
end;
$function$;

