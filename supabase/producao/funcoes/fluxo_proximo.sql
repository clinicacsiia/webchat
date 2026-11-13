-- public.fluxo_proximo(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_proximo(p_conversa uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; pa public.pre_agendamentos; n_itens int; v_conf jsonb; v_hist jsonb; v_procs int[]; v_med text[]; v_ja boolean;
begin
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb);
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select count(*) into n_itens from public.pre_agendamento_itens where conversa_id = p_conversa and ativo;
  if jsonb_typeof(d -> 'oferta_pendente') = 'object' then return 'horario_oferta'; end if;   -- pedido-sem-horario

  if not coalesce((d ->> 'identidade_feita')::boolean, false) then
    v_conf := public.paciente_conferir(p_conversa);
    if v_conf ->> 'situacao' = 'completo' and v_conf ->> 'dt_nasc_conferida' is null then return 'identidade'; end if;
    perform public.fluxo_set(p_conversa, '{"identidade_feita": true}');
  end if;
  if not coalesce((d ->> 'atalho_feito')::boolean, false) then
    perform public.fluxo_set(p_conversa, '{"atalho_feito": true}');
    if n_itens = 0 then
      v_hist := public.paciente_historico_para_ia(p_conversa);
      if coalesce((v_hist ->> 'liberado')::boolean, false)
         and (jsonb_array_length(coalesce(v_hist -> 'ultimas', '[]'::jsonb)) > 0 or jsonb_typeof(v_hist -> 'pedido_pela_metade') = 'object') then
        return 'atalho';
      end if;
    end if;
  end if;
  if d ->> 'motivo' = 'assunto' then
    return case when d ->> 'assunto' is null then 'assunto' else 'assunto_texto' end;
  end if;
  if n_itens = 0 and d ->> 'motivo' is null then return 'motivo'; end if;
  if n_itens = 0 or d ->> 'refazer' = 'pedido' then
    return case when coalesce(d ->> 'motivo', pa.tipo) = 'consulta' then 'consulta' else 'exame' end;
  end if;
  if pa.tipo = 'consulta' and not coalesce((d ->> 'medico_feito')::boolean, false)
     and not exists (select 1 from public.conversas cv where cv.id = p_conversa and cv.irmao_de is not null and cv.irmaos_modo = 'juntos') then
    v_med := public.fluxo_medicos(p_conversa);
    if coalesce(cardinality(v_med), 0) > 1 then return 'medico'; end if;
    perform public.fluxo_set(p_conversa, '{"medico_feito": true}');
  end if;
  -- klingo-auto: CPF e data de nascimento válidos são obrigatórios antes do plano (a agenda real e a marcação dependem deles)
  if not public.fluxo_cpf_ok(pa.paciente ->> 'cpf') or public.fluxo_ler_data(pa.paciente ->> 'dt_nasc') is null or coalesce((d ->> 'cpf_nasc_refazer')::boolean, false) then return 'cpf_nasc'; end if;
  if pa.plano is null then return 'plano'; end if;
  v_procs := public.fluxo_procs(p_conversa);
  if v_procs is not null and not coalesce((d ->> 'sem_horario')::boolean, false)
     and jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) < jsonb_array_length(public.agenda_grupos(v_procs)) then
    return 'horario';
  end if;
  v_ja := pa.identidade in ('conferida', 'atualizar') and d ->> 'mudou' is distinct from 'mudou'
          and nullif(btrim(coalesce(pa.paciente ->> 'nome', '')), '') is not null
          and nullif(btrim(coalesce(pa.paciente ->> 'sexo', '')), '') is not null
          and nullif(btrim(coalesce(pa.paciente ->> 'dt_nasc', '')), '') is not null
          and nullif(btrim(coalesce(pa.paciente ->> 'celular', '')), '') is not null
          and public.fluxo_cpf_ok(pa.paciente ->> 'cpf');   -- klingo-auto: quem não deixou CPF volta a ser perguntado
  if pa.identidade in ('conferida', 'atualizar') and d ->> 'mudou' is null and not v_ja then return 'mudou'; end if;
  if not v_ja and not coalesce((d ->> 'g_ident')::boolean, false) then return 'dados_ident'; end if;
  if not v_ja and not coalesce((d ->> 'g_contato')::boolean, false) then return 'dados_contato'; end if;
  -- carteirinha-removida: o passo 'dados_carteira' não é mais perguntado; o atendente confere o convênio depois.
  if not coalesce((d ->> 'confirmado')::boolean, false) then return 'confirmar'; end if;
  return 'pronto';
end $function$
;
