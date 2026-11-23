-- FLUXOGRAMA: entrada (conversa com celular/e-mail/nome/sexo já guardados) -> validação (fluxo_proximo grava o contato no pedido e pula dados_contato / dados_ident) -> saída (confirmar mostra tudo e deixa corrigir)
-- Versão 1.0 — 23/11/2026 / Mudança: não perguntar de novo o que já está salvo. Parte de supabase/producao/funcoes/fluxo_proximo.sql.
-- Rollback: dados-ja-salvos-nao-perguntar-rollback.sql
-- public.fluxo_proximo(p_conversa uuid)
-- Pode executar: service_role
CREATE OR REPLACE FUNCTION public.fluxo_proximo(p_conversa uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; pa public.pre_agendamentos; n_itens int; v_conf jsonb; v_hist jsonb; v_procs int[]; v_med text[]; v_ja boolean; v_cv public.conversas; v_ct public.contatos; v_cel text; v_mail text;
begin
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb);
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select count(*) into n_itens from public.pre_agendamento_itens where conversa_id = p_conversa and ativo;
  if jsonb_typeof(d -> 'oferta_pendente') = 'object' then return 'horario_oferta'; end if;   -- pedido-sem-horario
  if jsonb_typeof(d -> 'previsao') = 'object' then return 'previsao_' || (d -> 'previsao' ->> 'etapa'); end if;   -- pedido-previsao

  -- cpf-primeiro: CPF e data de nascimento válidos são a PRIMEIRA coisa da conversa (antes do menu Exame/Consulta/Outro assunto)
  if coalesce((d ->> 'nao_sou_eu')::boolean, false) and not coalesce((d ->> 'g_contato')::boolean, false) then return 'dados_contato'; end if;   -- identidade em fases: "não sou eu" = fase 1 (nome, celular, e-mail)
  if not public.fluxo_cpf_ok(pa.paciente ->> 'cpf') or public.fluxo_ler_data(pa.paciente ->> 'dt_nasc') is null or coalesce((d ->> 'cpf_nasc_refazer')::boolean, false) then return 'cpf_nasc'; end if;
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
    return public.fluxo_proximo_assunto(p_conversa, d);   -- v2.1
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
  -- primeira-consulta: primeira consulta com a médica controlada só com atendente (primeira_consulta_ok; desligada por padrão)
  if pa.tipo = 'consulta' and coalesce((public.primeira_consulta_ok(p_conversa) ->> 'bloqueia')::boolean, false) then return 'primeira_consulta'; end if;
  -- retorno-30-dias: pediu consulta na mesma especialidade com atendimento de menos de 30 dias: avisa e passa para a atendente (retorno_recente_ok; chave retorno_dias_modo)
  if pa.tipo = 'consulta' and coalesce((public.retorno_recente_ok(p_conversa) ->> 'bloqueia')::boolean, false) then return 'retorno_recente'; end if;
  -- klingo-auto: paciente que o chat já conhecia (dados guardados de antes, nada digitado nesta conversa) confirma só o CPF; conferência velha ou "não sou eu" = tudo de novo
  if public.klingo_ativo(p_conversa, 'klingo_api_marcar') and not coalesce((d ->> 'nao_sou_eu')::boolean, false) and not coalesce((d ->> 'cpf_confirmado')::boolean, false)
     and public.fluxo_cpf_ok(pa.paciente ->> 'cpf') and public.fluxo_ler_data(pa.paciente ->> 'dt_nasc') is not null and (d -> 'digitado' ->> 'cpf') is null then
    if exists (select 1 from public.klingo_identidade i where i.chave = public.klingo_hash(regexp_replace(pa.paciente ->> 'cpf', '\D', '', 'g') || '|' || public.fluxo_ler_data(pa.paciente ->> 'dt_nasc')::text)
                and i.situacao = 'confere' and i.conferido_em > now() - make_interval(days => coalesce(nullif(public.klingo_cfg('klingo_reconfirmar_dias', '90'), '')::int, 90))) then
      return 'cpf_confirma';
    end if;
    perform public.klingo_nao_sou_eu(p_conversa);
    return public.fluxo_proximo(p_conversa);
  end if;
  -- klingo-auto: CPF e data de nascimento válidos são obrigatórios antes do plano (a agenda real e a marcação dependem deles)
  if not public.fluxo_cpf_ok(pa.paciente ->> 'cpf') or public.fluxo_ler_data(pa.paciente ->> 'dt_nasc') is null or coalesce((d ->> 'cpf_nasc_refazer')::boolean, false) then return 'cpf_nasc'; end if;
  if pa.plano is null then return 'plano'; end if;
  -- plano-exato: convênio com muitos planos (Bradesco, SulAmérica, Unimed...) precisa do plano exato antes de consultar horários
  if public.plano_exato_convenio(pa.plano) is not null
     and (nullif(d ->> 'plano_exato_id', '') is null or lower(btrim(coalesce(d ->> 'plano_exato_de', ''))) is distinct from lower(btrim(pa.plano))) then
    return 'plano_exato';
  end if;
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
  -- dados-ja-salvos (23/11/2026): o que o chat já tem guardado NÃO é perguntado de novo (a confirmação final mostra tudo e deixa corrigir).
  --   contato: celular + e-mail válidos (do pedido, do formulário inicial ou do contato) -> grava no pedido e pula 'dados_contato'.
  --   identidade: nome + sexo já no pedido -> pula 'dados_ident'. Só o que falta é perguntado. "Não sou eu" e "mudou" continuam pedindo de novo.
  if not v_ja and not coalesce((d ->> 'nao_sou_eu')::boolean, false) and d ->> 'mudou' is distinct from 'mudou' then
    if not coalesce((d ->> 'g_contato')::boolean, false) then
      select * into v_cv from public.conversas where id = p_conversa;
      select * into v_ct from public.contatos where id = v_cv.contato_id;
      v_cel := regexp_replace(coalesce(nullif(pa.paciente ->> 'celular', ''), v_ct.telefone, ''), '\D', '', 'g');
      v_mail := lower(btrim(coalesce(nullif(pa.paciente ->> 'email', ''), nullif(btrim(v_cv.email_informado), ''), v_ct.email, '')));
      if public.fluxo_telefone_ok(v_cel) and public.fluxo_email_ok(v_mail) then
        perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', jsonb_build_object('celular', v_cel, 'email', v_mail), 'etapa', 'dados'));
        perform public.fluxo_set(p_conversa, '{"g_contato": true}');
        d := d || '{"g_contato": true}'::jsonb;
      end if;
    end if;
    if not coalesce((d ->> 'g_ident')::boolean, false)
       and public.fluxo_nome_ok(btrim(coalesce(pa.paciente ->> 'nome', ''))) and upper(left(coalesce(pa.paciente ->> 'sexo', ''), 1)) in ('M', 'F') then
      perform public.fluxo_set(p_conversa, '{"g_ident": true}');
      d := d || '{"g_ident": true}'::jsonb;
    end if;
  end if;
  if not v_ja and not coalesce((d ->> 'g_ident')::boolean, false) then return 'dados_ident'; end if;
  if not v_ja and not coalesce((d ->> 'g_contato')::boolean, false) then return 'dados_contato'; end if;
  -- carteirinha-removida: o passo 'dados_carteira' não é mais perguntado; o atendente confere o convênio depois.
  if not coalesce((d ->> 'confirmado')::boolean, false) then return 'confirmar'; end if;
  -- particular-valor: Particular só segue depois de ver o valor e responder (a resposta vale só para este plano + exames)
  if public.particular_valor_ativo(p_conversa) and (d -> 'valor_resp' ->> 'assin') is distinct from public.particular_valor_assinatura(p_conversa) then return 'valor'; end if;
  return 'pronto';
end $function$;

