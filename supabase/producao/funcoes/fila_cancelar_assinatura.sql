-- public.fila_cancelar_assinatura(p_atendimento uuid)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_cancelar_assinatura(p_atendimento uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.fila_exige_staff();
  update public.atendimentos
     set status = 'aguardando', documento_texto = null, documento_hash = null,
         tentativas_falhas = 0, bloqueado_em = null
   where id = p_atendimento and status = 'assinatura_pendente';
  if not found then
    raise exception 'Atendimento não está aguardando assinatura.' using errcode = 'P0001';
  end if;
end $function$;

