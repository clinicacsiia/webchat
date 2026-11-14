-- public.disponibilidade_evento_gravar(p_pedido uuid, p_tipo text, p_origem text, p_detalhe jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_evento_gravar(p_pedido uuid, p_tipo text, p_origem text DEFAULT 'sistema'::text, p_detalhe jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ insert into public.disponibilidade_evento (pedido_id, tipo, origem, detalhe) values (p_pedido, left(p_tipo, 40), left(p_origem, 40), coalesce(p_detalhe, '{}'::jsonb)) $function$;

