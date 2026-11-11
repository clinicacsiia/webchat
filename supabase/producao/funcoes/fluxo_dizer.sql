-- public.fluxo_dizer(p_conversa uuid, p_texto text, p_opcoes jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_dizer(p_conversa uuid, p_texto text, p_opcoes jsonb DEFAULT NULL::jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id bigint;
begin
  insert into public.mensagens (conversa_id, autor, texto, opcoes)
  values (p_conversa, 'agente', left(coalesce(nullif(btrim(p_texto), ''), '…'), 4000), p_opcoes) returning id into v_id;
  return v_id;
end $function$;

