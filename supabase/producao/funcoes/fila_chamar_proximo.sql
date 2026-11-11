-- public.fila_chamar_proximo()
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_chamar_proximo()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id uuid;
begin
  perform public.fila_equipe_ok();
  perform pg_advisory_xact_lock(hashtext('fila_chegada'));
  select id into v_id from public.fila_chegada where status = 'aguardando' and public.fila_dia(chegou_em) = public.fila_dia(now())
   order by chegou_em, id limit 1 for update skip locked;
  if v_id is null then return null; end if;
  update public.fila_chegada set status = 'chamado', chamado_em = now() where id = v_id;
  return v_id;
end $function$;

