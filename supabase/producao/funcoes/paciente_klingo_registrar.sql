-- public.paciente_klingo_registrar(p_conversa uuid, p_resultado jsonb)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.paciente_klingo_registrar(p_conversa uuid, p_resultado jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r jsonb := coalesce(p_resultado, '{}'::jsonb); v_sit text; v_falta text[]; v_h jsonb := r -> 'historico'; v_nota text;
begin
  if not exists (select 1 from public.paciente_klingo_vinculo where conversa_id = p_conversa) then return; end if;
  v_sit := case when r ->> 'erro' is not null then 'erro'
                when not coalesce((r ->> 'encontrado')::boolean, false) then 'nao_encontrado'
                when coalesce((r ->> 'ambiguo')::boolean, false) then 'ambiguo'
                when coalesce((r ->> 'confere')::boolean, false) then 'confere' else 'divergente' end;
  select coalesce(array_agg(x), '{}') into v_falta from jsonb_array_elements_text(coalesce(r -> 'cadastro_faltando', '[]'::jsonb)) x;
  update public.paciente_klingo_vinculo set situacao = v_sit, prontuario = case when v_sit = 'confere' then left(r ->> 'prontuario', 20) end,
    cadastro_faltando = v_falta, historico = case when v_sit = 'confere' then v_h end, verificado_em = now() where conversa_id = p_conversa;
  v_nota := case v_sit
    when 'confere' then 'Klingo: cadastro localizado e nascimento conferido (prontuário ' || coalesce(r ->> 'prontuario', '?') || ')'
    when 'divergente' then 'Klingo: CPF existe, mas a data de nascimento NÃO confere. Conferir o documento antes de usar o cadastro'
    when 'ambiguo' then 'Klingo: o CPF aparece em mais de um prontuário. Verificar cadastro duplicado'
    when 'nao_encontrado' then 'Klingo: CPF não encontrado. Provável paciente novo'
    else null end;
  if v_nota is not null then perform public.fluxo_nota(p_conversa, v_nota); end if;
  if v_sit = 'confere' and cardinality(v_falta) > 0 then
    perform public.fluxo_nota(p_conversa, 'Cadastro no Klingo sem: ' || array_to_string(v_falta, ', ') || '. Pedir ao paciente e atualizar');
  end if;
  if v_sit = 'confere' and coalesce((v_h ->> 'total')::int, 0) > 0 then
    perform public.fluxo_nota(p_conversa, 'Histórico no Klingo (12 meses): ' || (v_h ->> 'total') || ' marcações; a última em ' || coalesce(v_h ->> 'ultima_data', '?') || ' (' || coalesce(left(v_h ->> 'ultimo_procedimento', 80), '?') || ')');
  end if;
end $function$;

