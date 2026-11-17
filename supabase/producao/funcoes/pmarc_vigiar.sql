-- public.pmarc_vigiar()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.pmarc_vigiar()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare e public.pmarc_estado%rowtype; v_modo text;
begin
  if not public.pmarc_ligada() then return 'desligada'; end if;
  perform pg_advisory_xact_lock(hashtext('pmarc_vigiar'));
  select * into e from public.pmarc_estado where id;
  if e.tentativa_em is not null and e.tentativa_em > now() - interval '3 minutes' then return 'em andamento'; end if;
  v_modo := case when e.completo_em is null or e.completo_em < now() - interval '60 minutes' then 'completo' else 'rapido' end;
  perform public.pmarc_disparar(v_modo);
  return v_modo;
end $function$;

