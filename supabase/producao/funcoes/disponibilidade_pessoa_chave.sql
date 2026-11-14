-- public.disponibilidade_pessoa_chave(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.disponibilidade_pessoa_chave(p_conversa uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb := public.klingo_dados_conversa(p_conversa); v_nome text;
begin
  if d ->> 'cpf' is null or d ->> 'nascimento' is null then return null; end if;
  select coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), nullif(btrim(c.paciente_nome), ''), nullif(btrim(c.nome_informado), ''), '') into v_nome
    from public.conversas c left join public.pre_agendamentos pa on pa.conversa_id = c.id where c.id = p_conversa;
  return public.klingo_hash((d ->> 'cpf') || '|' || (d ->> 'nascimento') || '|' || coalesce(public.norm_nome(v_nome), ''));
end $function$;

