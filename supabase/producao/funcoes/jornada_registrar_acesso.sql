-- public.jornada_registrar_acesso(p_card bigint)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.jornada_registrar_acesso(p_card bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if auth.uid() is null or not public.jornada_pode() then return; end if;
  if exists (select 1 from public.jornada_card where id = p_card) then
    insert into public.jornada_acesso (card_id, usuario) values (p_card, auth.uid());
  end if;
end;
$function$;

