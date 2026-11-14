-- public.chat_disponibilidade_ver(p_conversa uuid, p_token text)
-- Pode executar: anon, authenticated, service_role
CREATE OR REPLACE FUNCTION public.chat_disponibilidade_ver(p_conversa uuid, p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_pessoa text;
begin
  perform public.chat_valida(p_conversa, p_token);
  v_pessoa := public.disponibilidade_pessoa_chave(p_conversa);
  return jsonb_build_object('solicitacoes', coalesce((select jsonb_agg(public.disponibilidade_json(p) order by p.criado_em desc) from public.disponibilidade_pedido p
      where (p.conversa_id = p_conversa or (v_pessoa is not null and p.pessoa_chave = v_pessoa)) and (p.estado not in ('expirada', 'cancelada', 'convertida_em_agendamento') or p.atualizado_em > now() - interval '30 days')), '[]'::jsonb));
end $function$;

