-- public.agendamento_fechar_interno(p_conversa uuid, p_desfecho text, p_origem text, p_por uuid, p_nota text)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.agendamento_fechar_interno(p_conversa uuid, p_desfecho text, p_origem text, p_por uuid, p_nota text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a record; v_id bigint;
begin
  if p_desfecho not in ('compareceu', 'faltou', 'cancelou', 'remarcou') then raise exception 'Desfecho inválido.' using errcode = '22023'; end if;
  select * into a from public.v_agendamento_aberto where conversa_id = p_conversa order by quando nulls last limit 1;
  if not found then return null; end if;
  insert into public.agendamento_fechamento (pre_id, conversa_id, chave, exames, quando, desfecho, origem, por, nota, remarcacao)
  values (a.pre_id, p_conversa, a.chave, a.exames, a.quando, p_desfecho, p_origem, p_por, left(p_nota, 500), case when p_desfecho = 'faltou' then 'pendente' end)
  on conflict (chave) do nothing returning id into v_id;
  return v_id;
end $function$;

