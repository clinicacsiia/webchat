-- public.klingo_identidade_registrar(p_cpf text, p_nasc date, p_r jsonb, p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.klingo_identidade_registrar(p_cpf text, p_nasc date, p_r jsonb, p_conversa uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'); v_chave text; v_hash text; v_sit text := coalesce(p_r ->> 'situacao', 'erro');
  v_id text := nullif(p_r ->> 'klingo_id', ''); v_tipo text; v_falta text[]; v_plano integer; v_ex public.klingo_identidade; v_n integer := 0; v_nota text; v_pront text; r record; v_cmp text;
begin
  if not public.fluxo_cpf_ok(v_cpf) or p_nasc is null then raise exception 'CPF ou nascimento inválido' using errcode = '22023'; end if;
  if v_sit not in ('confere', 'divergente', 'nao_encontrado', 'sem_id_definitivo', 'erro') then v_sit := 'erro'; end if;
  v_chave := public.klingo_hash(v_cpf || '|' || p_nasc::text); v_hash := public.klingo_hash(v_cpf);
  v_tipo := case when v_sit = 'confere' and v_id ~ '^P[0-9]+$' then 'definitivo' end;
  if v_tipo is null then v_id := null; end if;
  v_falta := coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(p_r -> 'faltando') = 'array' then p_r -> 'faltando' else '[]'::jsonb end)), '{}');
  v_plano := case when (p_r ->> 'plano_id') ~ '^[0-9]{1,9}$' then (p_r ->> 'plano_id')::integer end;
  select * into v_ex from public.klingo_identidade where chave = v_chave;
  -- Falha de rede não apaga uma conferência boa; pré-cadastro já criado não some só porque a busca por CPF não o enxerga.
  if v_ex.id is not null and ((v_sit = 'erro' and v_ex.situacao in ('confere', 'pre_cadastro')) or (v_ex.tipo = 'pre' and v_sit <> 'confere')) then
    update public.klingo_identidade set conferido_em = now() where id = v_ex.id;
    v_sit := v_ex.situacao; v_id := v_ex.klingo_id; v_tipo := v_ex.tipo; v_falta := v_ex.faltando; v_plano := v_ex.plano_id;
  else
    insert into public.klingo_identidade (chave, cpf_hash, tipo, klingo_id, situacao, faltando, plano_id, conferido_em)
    values (v_chave, v_hash, v_tipo, v_id, v_sit, v_falta, v_plano, now())
    on conflict (chave) do update set tipo = excluded.tipo, klingo_id = excluded.klingo_id, situacao = excluded.situacao, faltando = excluded.faltando,
      plano_id = excluded.plano_id, conferido_em = now(),
      convertido_em = case when public.klingo_identidade.tipo = 'pre' and excluded.tipo = 'definitivo' then now() else public.klingo_identidade.convertido_em end;
  end if;

  if v_id is not null then
    -- liga os pedidos (e a pessoa unificada) ao cadastro do Klingo
    update public.pre_agendamentos set klingo_paciente_id = v_id
     where klingo_paciente_id is distinct from v_id and regexp_replace(coalesce(paciente ->> 'cpf', ''), '\D', '', 'g') = v_cpf and public.fluxo_ler_data(paciente ->> 'dt_nasc') = p_nasc;
    get diagnostics v_n = row_count;
    update public.pacientes set dados = jsonb_set(coalesce(dados, '{}'::jsonb), '{klingo}', jsonb_build_object('id', v_id, 'conferido_em', now()), true)
     where regexp_replace(coalesce(cpf, ''), '\D', '', 'g') = v_cpf and dt_nasc = p_nasc and (dados -> 'klingo' ->> 'id') is distinct from v_id;
    -- medida: o número do prontuário do relatório é o mesmo do id da API? (decide se um dia dá para usar o id da API no reconhecimento)
    for r in select v.prontuario from public.paciente_klingo_vinculo v join public.pre_agendamentos pa on pa.conversa_id = v.conversa_id
              where v.situacao = 'confere' and nullif(v.prontuario, '') is not null and regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g') = v_cpf limit 1 loop
      perform public.klingo_medir(case when r.prontuario = substr(v_id, 2) then 'prontuario_igual_id_api' else 'prontuario_diferente_id_api' end);
    end loop;
  end if;

  -- situação por conversa (sem mexer no prontuário do relatório e sem rebaixar quem o relatório já confirmou)
  update public.paciente_klingo_vinculo v set situacao = case v_sit when 'sem_id_definitivo' then 'ambiguo' else v_sit end, cadastro_faltando = v_falta, verificado_em = now()
   where v.situacao <> 'confere' and v_sit <> 'erro'
     and v.conversa_id in (select pa.conversa_id from public.pre_agendamentos pa where regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g') = v_cpf and public.fluxo_ler_data(pa.paciente ->> 'dt_nasc') = p_nasc);

  if p_conversa is not null then
    v_nota := case v_sit
      when 'confere' then 'Klingo (API): cadastro localizado e nascimento conferido.'
      when 'divergente' then 'Klingo (API): o CPF existe, mas a data de nascimento NÃO confere. Conferir o documento antes de usar o cadastro.'
      when 'nao_encontrado' then 'Klingo (API): CPF não encontrado. Paciente novo (o sistema cria o pré-cadastro na hora de marcar).'
      when 'sem_id_definitivo' then 'Klingo (API): o CPF aparece, mas sem cadastro definitivo. Verificar duplicidade.'
      else null end;
    if v_nota is not null and not exists (select 1 from public.conversa_fluxo f where f.conversa_id = p_conversa and f.dados -> 'notas' ? left(v_nota, 300)) then perform public.fluxo_nota(p_conversa, v_nota); end if;
    if v_sit = 'confere' and cardinality(v_falta) > 0 then
      v_nota := 'Cadastro no Klingo sem: ' || array_to_string(v_falta, ', ') || '. Pedir ao paciente e atualizar.';
      if not exists (select 1 from public.conversa_fluxo f where f.conversa_id = p_conversa and f.dados -> 'notas' ? left(v_nota, 300)) then perform public.fluxo_nota(p_conversa, v_nota); end if;
    end if;
  end if;
  perform public.klingo_medir('identidade_' || v_sit);
  return jsonb_build_object('ok', true, 'situacao', v_sit, 'pedidos_ligados', v_n);
end $function$;

