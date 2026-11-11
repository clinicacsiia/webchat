-- public.agendamento_remarcacao_resolver(p_fechamento bigint, p_resultado text, p_nota text)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.agendamento_remarcacao_resolver(p_fechamento bigint, p_resultado text, p_nota text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.pessoa_equipe();
  if p_resultado not in ('feita', 'recusada') then raise exception 'Resultado inválido.' using errcode = '22023'; end if;
  update public.agendamento_fechamento set remarcacao = p_resultado, atualizado_em = now(), nota = coalesce(nullif(left(p_nota, 500), ''), nota)
   where id = p_fechamento and remarcacao in ('pendente', 'pedida', 'aceita');
  if not found then raise exception 'Esta remarcação já foi resolvida.' using errcode = '22023'; end if;
  return jsonb_build_object('ok', true);
end $function$;

