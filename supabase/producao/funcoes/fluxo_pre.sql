-- public.fluxo_pre(p_conversa uuid, p_dados jsonb, p_pronto boolean)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_pre(p_conversa uuid, p_dados jsonb, p_pronto boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_seg text;
begin
  select valor into v_seg from public.config where chave = 'ia_segredo';
  return public.ia_pre_agendar(v_seg, p_conversa, p_dados, p_pronto);
end $function$;

