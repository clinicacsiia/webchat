-- public.pessoa_corrigir_data(p_a uuid, p_b uuid, p_ids uuid[], p_data date)
-- Pode executar: authenticated, service_role
CREATE OR REPLACE FUNCTION public.pessoa_corrigir_data(p_a uuid, p_b uuid, p_ids uuid[], p_data date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform public.pessoa_equipe();
  if p_data is null or p_data > current_date or p_data < date '1900-01-01' then raise exception 'Data de nascimento inválida.' using errcode = '22023'; end if;
  update public.pre_agendamentos set paciente = jsonb_set(coalesce(paciente, '{}'::jsonb), '{dt_nasc}', to_jsonb(p_data::text))
   where conversa_id = any (p_ids);
  return public.pessoa_confirmar(p_a, p_b);
end $function$;

