-- public.fila_minha_vez_ticket(p_ticket uuid)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.fila_minha_vez_ticket(p_ticket uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.fila_chegada%rowtype;
begin
  select * into r from public.fila_chegada where ticket = p_ticket;
  if r.id is null then return jsonb_build_object('situacao', 'fora', 'ticket_invalido', true); end if;
  return public.fila_situacao_linha(r);
end $function$;

