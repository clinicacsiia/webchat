-- public.fila_concluir(p_atendimento uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_concluir(p_atendimento uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.fila_exige_staff();
  update public.atendimentos set status = 'concluido' where id = p_atendimento and status = 'em_atendimento';
  if not found then
    raise exception 'Atendimento não está em atendimento.' using errcode = 'P0001';
  end if;
end $function$;

