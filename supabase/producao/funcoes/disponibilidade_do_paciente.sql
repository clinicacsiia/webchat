-- public.disponibilidade_do_paciente(p_conversa uuid, p_id uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_do_paciente(p_conversa uuid, p_id uuid)
 RETURNS public.disponibilidade_pedido
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.disponibilidade_pedido; v_pessoa text := public.disponibilidade_pessoa_chave(p_conversa);
begin
  select * into r from public.disponibilidade_pedido p where p.id = p_id and (p.conversa_id = p_conversa or (v_pessoa is not null and p.pessoa_chave = v_pessoa));
  if r.id is null then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  return r;
end $function$;

