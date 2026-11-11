-- public.jornada_acordar()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_acordar()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or not public.jornada_pode() then
    return;
  end if;
  update public.jornada_sync_estado
     set klingo_movimento_em = now(), klingo_proximo_em = least(coalesce(klingo_proximo_em, now()), now())
   where id and (klingo_movimento_em is null or klingo_movimento_em < now() - interval '1 minute');
end;
$function$;

