-- public.fila_chamar_assinatura(p_atendimento uuid, p_texto text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_chamar_assinatura(p_atendimento uuid, p_texto text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.fila_exige_staff();
  if p_texto is null or char_length(p_texto) not between 20 and 20000 then
    raise exception 'Texto do documento inválido (entre 20 e 20.000 caracteres).' using errcode = '22023';
  end if;
  update public.atendimentos
     set status = 'assinatura_pendente',
         documento_texto = p_texto,
         documento_hash = encode(sha256(convert_to(p_texto, 'UTF8')), 'hex'),
         tentativas_falhas = 0,
         bloqueado_em = null
   where id = p_atendimento and status = 'aguardando';
  if not found then
    raise exception 'Atendimento não está aguardando na fila.' using errcode = 'P0001';
  end if;
end $function$;

