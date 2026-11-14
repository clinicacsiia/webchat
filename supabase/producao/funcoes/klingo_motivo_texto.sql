-- public.klingo_motivo_texto(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_motivo_texto(p_conversa uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case f.motivo
    when 'sem_medico' then 'o Klingo não tem médico credenciado para esta especialidade e este convênio'
    when 'plano_inativo' then 'o convênio está inativo no Klingo'
    when 'plano_desconhecido' then 'o Klingo não reconhece o plano do convênio'
    when 'sem_traducao' then 'este convênio ainda não tem tradução para o plano do Klingo'
    when 'plano_do_cadastro_necessario' then 'o plano deste convênio só é descoberto pelo cadastro do paciente no Klingo (paciente novo não tem)'
    when 'fora_do_escopo' then 'esta especialidade ou exame ainda não foi liberado para a marcação sozinha'
    when 'dados_incompletos' then 'faltou CPF, nascimento ou convênio para buscar os horários'
    when 'sem_pedido' then 'o pedido ainda não tinha dados suficientes'
    when 'api_sem_horario' then 'o Klingo não devolveu nenhum horário livre para este pedido'
    when 'limite' then 'o limite de chamadas ao Klingo foi atingido naquele momento'
    when 'indisponivel' then 'o Klingo não respondeu os horários (falha técnica)'
    when 'sem_chave' then 'a chave de acesso ao Klingo não está configurada'
    else f.motivo end
    || case when f.detalhe is not null and f.motivo in ('indisponivel', 'sem_medico', 'plano_inativo', 'plano_desconhecido') then ' [' || f.detalhe || ']' else '' end
  from public.klingo_horarios_falha f where f.conversa_id = p_conversa
$function$;

