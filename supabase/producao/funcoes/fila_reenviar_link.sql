-- public.fila_reenviar_link(p_atendimento uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_reenviar_link(p_atendimento uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.fila_exige_staff();
  if not exists (select 1 from public.atendimentos where id = p_atendimento and status in ('aguardando', 'assinatura_pendente')) then
    raise exception 'Este atendimento não está na fila.' using errcode = 'P0001';
  end if;
  perform public.fila_avisar_n8n(p_atendimento);
end $function$;

