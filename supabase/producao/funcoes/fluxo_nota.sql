-- public.fluxo_nota(p_conversa uuid, p_nota text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_nota(p_conversa uuid, p_nota text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  update public.conversa_fluxo set dados = jsonb_set(dados, '{notas}', coalesce(dados -> 'notas', '[]'::jsonb) || to_jsonb(left(p_nota, 300))), atualizado_em = now()
  where conversa_id = p_conversa
$function$;

