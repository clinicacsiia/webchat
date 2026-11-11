-- public.atendimentos_transicao_trg()
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.atendimentos_transicao_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'aguardando'          and new.status = 'assinatura_pendente')
    or (old.status = 'assinatura_pendente' and new.status in ('aguardando', 'em_atendimento'))
    or (old.status = 'em_atendimento'      and new.status = 'concluido')
  ) then
    raise exception 'Transição de status não permitida: % -> %.', old.status, new.status using errcode = 'P0001';
  end if;
  if old.status in ('em_atendimento', 'concluido')
     and (new.documento_hash is distinct from old.documento_hash or new.documento_texto is distinct from old.documento_texto) then
    raise exception 'Documento de atendimento já assinado não pode ser alterado.' using errcode = 'P0001';
  end if;
  new.atualizado_em := now();
  return new;
end $function$;

