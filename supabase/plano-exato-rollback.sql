-- Rollback de supabase/plano-exato.sql (volta as funções ao retrato da produção de 16/11/2026 e desliga o passo).
-- Antes de tudo (instantâneo, sem mexer em função): update public.config set valor = 'nao' where chave = 'plano_exato_modo';

CREATE OR REPLACE FUNCTION public.klingo_plano_resolver(p_operadora text, p_plano_cadastro integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare m public.klingo_plano_map;
begin
  select * into m from public.klingo_plano_map where lower(btrim(operadora)) = lower(btrim(coalesce(p_operadora, ''))) limit 1;
  if m.operadora is null or m.origem = 'nao_atende' then return jsonb_build_object('plano_id', null, 'motivo', 'sem_traducao'); end if;
  if public.norm_nome(p_operadora) = 'PARTICULAR' and m.plano_id is not null then return jsonb_build_object('plano_id', m.plano_id, 'via', 'padrao'); end if;
  if p_plano_cadastro is not null and m.convenio_id is not null
     and exists (select 1 from public.klingo_convenio k where k.plano_id = p_plano_cadastro and k.convenio_id = m.convenio_id) then
    return jsonb_build_object('plano_id', p_plano_cadastro, 'via', 'cadastro');
  end if;
  if m.plano_id is not null then return jsonb_build_object('plano_id', m.plano_id, 'via', 'padrao'); end if;
  return jsonb_build_object('plano_id', null, 'motivo', 'plano_do_cadastro_necessario');
end $function$;

CREATE OR REPLACE FUNCTION public.klingo_dados_conversa(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa public.pre_agendamentos; c public.conversas; ct public.contatos; v_cpf text; v_nasc date; v_i public.klingo_identidade; v_procs integer[]; v_n integer; v_proc integer;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select * into c from public.conversas where id = p_conversa;
  select * into ct from public.contatos where id = c.contato_id;
  v_cpf := regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g');
  v_nasc := public.fluxo_ler_data(pa.paciente ->> 'dt_nasc');
  if public.fluxo_cpf_ok(v_cpf) and v_nasc is not null then
    select * into v_i from public.klingo_identidade where chave = public.klingo_hash(v_cpf || '|' || v_nasc::text);
  end if;
  select array_agg(i.procedimento_id order by i.id) into v_procs from public.pre_agendamento_itens i,
    lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  v_n := coalesce(cardinality(v_procs), 0); v_proc := v_procs[1];
  return jsonb_build_object(
    'tipo', pa.tipo, 'plano', pa.plano, 'pre_agendamento_id', pa.id, 'status', pa.status, 'procedimentos', coalesce(to_jsonb(v_procs), '[]'::jsonb), 'n_procedimentos', v_n, 'procedimento', v_proc,
    'cpf', case when public.fluxo_cpf_ok(v_cpf) then v_cpf end, 'nascimento', v_nasc,
    'nome', nullif(btrim(pa.paciente ->> 'nome'), ''), 'sexo', nullif(btrim(pa.paciente ->> 'sexo'), ''), 'mae', nullif(btrim(pa.paciente ->> 'mae'), ''),
    'celular', coalesce(nullif(regexp_replace(coalesce(pa.paciente ->> 'celular', ''), '\D', '', 'g'), ''), regexp_replace(coalesce(ct.telefone, ''), '\D', '', 'g')),
    'email', nullif(btrim(pa.paciente ->> 'email'), ''),
    'teste', coalesce(c.teste, false),
    'identidade', case when v_i.id is null then null else jsonb_build_object('situacao', v_i.situacao, 'tipo', v_i.tipo, 'klingo_id', v_i.klingo_id, 'plano_id', v_i.plano_id, 'conferido_em', v_i.conferido_em) end);
end $function$;

CREATE OR REPLACE FUNCTION public.klingo_pode_marcar(p_conversa uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa public.pre_agendamentos; d jsonb; e jsonb; o public.klingo_oferta; v_id jsonb; v_pl jsonb; v_novo boolean := false; v_rem boolean := false;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if not public.klingo_ativo(p_conversa, 'klingo_api_marcar') then return jsonb_build_object('ok', false, 'motivo', 'desligado'); end if;
  v_rem := coalesce((select jsonb_typeof(f.dados -> 'remarcando') = 'object' from public.conversa_fluxo f where f.conversa_id = p_conversa), false);
  if pa.id is null or (pa.status = 'agendado' and not v_rem) then return jsonb_build_object('ok', false, 'motivo', 'ja_agendado'); end if;
  if v_rem and ((pa.agendado_origem is distinct from 'chat_api' and not exists (select 1 from public.klingo_marcacao km where km.conversa_id = p_conversa and km.situacao = 'ativa' and km.consultado_em > now() - interval '6 hours' and km.voucher = (select f2.dados -> 'remarcando' ->> 'voucher' from public.conversa_fluxo f2 where f2.conversa_id = p_conversa))) or not public.klingo_ativo(p_conversa, 'klingo_api_remarcar')) then return jsonb_build_object('ok', false, 'motivo', 'remarcar_desligado'); end if;
  d := public.klingo_dados_conversa(p_conversa);
  if (d ->> 'n_procedimentos')::int <> 1 then return jsonb_build_object('ok', false, 'motivo', 'varios_procedimentos'); end if;
  if jsonb_typeof(pa.escolha_horario) <> 'array' or jsonb_array_length(pa.escolha_horario) <> 1 then return jsonb_build_object('ok', false, 'motivo', 'horario_nao_unico'); end if;
  e := pa.escolha_horario -> 0;
  select * into o from public.klingo_oferta where conversa_id = p_conversa and chave = e ->> 'klingo_chave' and not sombra and expira_em > now() - interval '20 minutes';
  if o.id is null then
    return jsonb_build_object('ok', false, 'motivo', 'sem_oferta_da_api',
      'detalhe', coalesce(public.klingo_motivo_texto(p_conversa), 'o chat não recebeu horários reais do Klingo nesta conversa (o horário escolhido veio da grade)'));
  end if;
  if o.procedimento is distinct from (d ->> 'procedimento')::int
     and not exists (select 1 from public.klingo_especialidade e where (d ->> 'procedimento')::int = any (e.procedimentos) and o.procedimento = any (e.procedimentos)) then
    return jsonb_build_object('ok', false, 'motivo', 'oferta_de_outro_procedimento');
  end if;
  if d ->> 'cpf' is null or d ->> 'nascimento' is null or d ->> 'nome' is null or d ->> 'sexo' is null then return jsonb_build_object('ok', false, 'motivo', 'dados_incompletos'); end if;
  v_id := d -> 'identidade';
  if v_id is not null and jsonb_typeof(v_id) = 'object' then
    if v_id ->> 'situacao' in ('divergente', 'sem_id_definitivo') then return jsonb_build_object('ok', false, 'motivo', 'cadastro_divergente'); end if;
    if v_id ->> 'situacao' = 'nao_encontrado' then v_novo := true; end if;
  end if;
  if v_novo and not public.klingo_ativo(p_conversa, 'klingo_api_pre_cadastro') then return jsonb_build_object('ok', false, 'motivo', 'paciente_novo'); end if;
  v_pl := public.klingo_plano_resolver(pa.plano, nullif(v_id ->> 'plano_id', '')::int);
  if (v_pl ->> 'plano_id') is null and not (v_id is null or v_id ->> 'situacao' is null) then return jsonb_build_object('ok', false, 'motivo', coalesce(v_pl ->> 'motivo', 'sem_plano')); end if;
  if (v_pl ->> 'plano_id') is not null and (v_pl ->> 'plano_id')::int is distinct from o.plano and (v_pl ->> 'via') = 'padrao' and o.plano <> (v_pl ->> 'plano_id')::int and v_id is not null then
    return jsonb_build_object('ok', false, 'motivo', 'plano_mudou_depois_da_oferta');
  end if;
  if pa.tipo = 'exame' and public.norm_nome(pa.plano) <> 'PARTICULAR' and public.klingo_cfg('klingo_api_exame_convenio', 'nao') <> 'sim' then
    return jsonb_build_object('ok', false, 'motivo', 'exame_com_convenio');
  end if;
  return jsonb_build_object('ok', true, 'novo', v_novo, 'remarcar', v_rem);
end $function$;

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
end $function$;

CREATE OR REPLACE FUNCTION public.fluxo_perguntar(p_conversa uuid, p_passo text, p_prefixo text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  ctx jsonb := public.fluxo_ctx(p_conversa); c public.conversas; pa public.pre_agendamentos; d jsonb;
  v_txt text; v_op jsonb; v_hist jsonb; v_it jsonb := '[]'::jsonb; v_ult jsonb; v_pend jsonb; v_med text[]; v_nome text; v_tel text; x text; v_dig jsonb;
  v_etapa text; v_nse boolean; v_pref text := p_prefixo;
begin
  select * into c from public.conversas where id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb); v_dig := coalesce(pa.paciente, '{}'::jsonb) || coalesce(d -> 'digitado', '{}'::jsonb);
  v_nse := coalesce((d ->> 'nao_sou_eu')::boolean, false);   -- "não sou eu": nenhum preenchimento prévio
  if v_nse then v_dig := coalesce(d -> 'digitado', '{}'::jsonb); end if;

  case p_passo
  when 'identidade' then
    v_txt := public.fluxo_t('identidade', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'pular', 'Prefiro não informar agora',
      'campos', jsonb_build_array(jsonb_build_object('nome', 'dt_nasc', 'rotulo', 'Data de nascimento' || (ctx ->> 'de_quem'), 'tipo', 'data', 'obrigatorio', true)));
  when 'atalho' then
    v_hist := public.paciente_historico_para_ia(p_conversa);
    v_ult := v_hist -> 'ultimas' -> 0; v_pend := v_hist -> 'pedido_pela_metade';
    v_txt := public.fluxo_t('atalho', ctx);
    if v_ult is not null and jsonb_array_length(coalesce(v_ult -> 'exames', '[]'::jsonb)) > 0 then
      select string_agg(coalesce(e ->> 'exame', e ->> 'modalidade') || coalesce(' (' || (e ->> 'lado') || ')', ''), ' + ') into x from jsonb_array_elements(v_ult -> 'exames') e;
      if coalesce((v_ult ->> 'futuro')::boolean, false) then
        v_txt := v_txt || E'\n' || format('Você já tem %s marcado para %s.', x, v_ult ->> 'quando');
      else
        v_it := v_it || jsonb_build_object('valor', 'ultimo', 'rotulo', 'Repetir o último exame', 'desc', x || ' — ' || (v_ult ->> 'quando'));
      end if;
    end if;
    if jsonb_typeof(v_pend) = 'object' and v_pend ->> 'status' <> 'pronto' then
      select string_agg(coalesce(e ->> 'exame', e ->> 'modalidade'), ' + ') into x from jsonb_array_elements(coalesce(v_pend -> 'exames', '[]'::jsonb)) e;
      v_it := v_it || jsonb_build_object('valor', 'pendente', 'rotulo', 'Continuar o pedido que ficou pela metade', 'desc', coalesce(x, ''));
    end if;
    v_it := v_it || jsonb_build_object('valor', 'outro', 'rotulo', 'Fazer outro pedido');
    v_op := public.fluxo_escolha(p_passo, v_it);
  when 'motivo' then
    v_txt := public.fluxo_t(case when (ctx ->> 'filho')::boolean then 'motivo_filho' else 'motivo_proprio' end, ctx);
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'exame', 'rotulo', 'Exame', 'desc', 'Ressonância, tomografia, ultrassom, raio-X, mamografia e outros'),
      jsonb_build_object('valor', 'consulta', 'rotulo', 'Consulta', 'desc', case when (ctx ->> 'filho')::boolean then 'Pediatria e especialidades' else 'Com médico ou especialista' end),
      jsonb_build_object('valor', 'assunto', 'rotulo', 'Outro assunto', 'desc', 'Remarcar, cancelar, resultado de exame, dúvida')));
  when 'exame' then
    v_txt := public.fluxo_t('exame', ctx);
    v_op := jsonb_build_object('tipo', 'busca_exame', 'passo', p_passo, 'termo', d ->> 'termo');
  when 'consulta' then
    v_txt := public.fluxo_t('consulta', ctx);
    v_op := jsonb_build_object('tipo', 'pedido_consulta', 'passo', p_passo);
  when 'medico' then
    v_med := public.fluxo_medicos(p_conversa);
    select coalesce(jsonb_agg(jsonb_build_object('valor', m, 'rotulo', initcap(lower(m))) order by m), '[]'::jsonb) into v_it from unnest(v_med) m;
    select lower(x2.rotulo) into x from public.pre_agendamento_itens i
      cross join lateral public.consultas_da_unidade((select u.catalogo from public.unidade_config u where u.chave = c.unidade_inicial)) x2
      where i.conversa_id = p_conversa and i.ativo and i.modalidade = 'CONSULTA' and x2.id = i.procedimento_id limit 1;
    v_txt := public.fluxo_t('medico', ctx || jsonb_build_object('consulta', coalesce(x, 'a consulta')));
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', '', 'rotulo', 'Tanto faz (qualquer médico)')) || v_it);
  when 'assunto' then
    v_txt := public.fluxo_t('assunto', ctx);
    v_op := public.fluxo_escolha(p_passo, (case when public.klingo_ativo(p_conversa, 'klingo_api_consultar') then jsonb_build_array(jsonb_build_object('valor', 'Minhas marcações', 'rotulo', 'Ver minhas marcações')) else '[]'::jsonb end) || jsonb_build_array(
      jsonb_build_object('valor', 'Remarcar', 'rotulo', 'Remarcar um horário'), jsonb_build_object('valor', 'Cancelar', 'rotulo', 'Cancelar um horário'),
      jsonb_build_object('valor', 'Resultado de exame', 'rotulo', 'Resultado de exame'), jsonb_build_object('valor', 'Dúvida', 'rotulo', 'Tirar uma dúvida'),
      jsonb_build_object('valor', 'Reclamação', 'rotulo', 'Reclamação ou sugestão'), jsonb_build_object('valor', 'Outro', 'rotulo', 'Outro assunto')));
  when 'exame_aberto', 'remarcar_falta' then
    v_op := public.fluxo_pos_pergunta(p_conversa, p_passo);
    v_txt := v_op ->> 'texto';
    v_op := v_op -> 'op';
  when 'marc_consultando', 'marc_lista', 'marc_acao', 'marc_cancelar', 'marc_vazio', 'marc_pos', 'resultado_situacao', 'resultado_orientacao' then   -- v2.1: pós-agendamento e resultado
    v_op := public.fluxo_marc_pergunta(p_conversa, p_passo);
    v_txt := v_op ->> 'texto';
    v_op := v_op -> 'op';
  when 'assunto_qual', 'assunto_confirma', 'assunto_resultado', 'assunto_fim' then
    v_op := public.fluxo_assunto_pergunta(p_conversa, p_passo);
    v_txt := v_op ->> 'texto';
    v_op := v_op -> 'op';
  when 'assunto_texto' then
    v_txt := public.fluxo_t('assunto_texto', ctx);
    v_op := jsonb_build_object('tipo', 'texto', 'passo', p_passo, 'texto_livre', true, 'placeholder', 'Escreva aqui');
  when 'plano' then
    v_txt := public.fluxo_t('plano', ctx);
    select coalesce(jsonb_agg(jsonb_build_object('valor', o.operadora, 'rotulo', initcap(lower(o.operadora))) order by o.n desc, o.operadora), '[]'::jsonb) into v_it
    -- convenios-e-foto: convênio desativado pela gestão não entra na lista.
    from (select operadora, count(*) n from public.catalogo_plano where coalesce(ativo, true) and operadora !~* '^(teste|particular)$' and public.convenio_ativo(operadora) group by operadora) o;
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'Particular', 'rotulo', 'Particular (sem convênio)')) || v_it,
      jsonb_build_object('filtro', true, 'outro', jsonb_build_object('rotulo', 'Meu convênio não está na lista', 'placeholder', 'Nome do convênio')));
  when 'plano_confirma' then
    x := d ->> 'plano_anterior';
    v_txt := public.fluxo_t('plano_confirma', ctx || jsonb_build_object('como',
      case when lower(btrim(x)) = 'particular' then 'particular' else 'pelo convênio ' || initcap(lower(x)) end));
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'sim', 'rotulo', 'Sim, é o mesmo'),
                                                            jsonb_build_object('valor', 'nao', 'rotulo', 'Não, mudou')));
  when 'previsao_turno', 'previsao_periodo', 'previsao_decide', 'previsao_antecedencia' then   -- pedido-previsao
    v_ult := public.previsao_pergunta(p_conversa, p_passo); v_txt := v_ult ->> 'texto'; v_op := v_ult -> 'opcoes';
  when 'horario_oferta' then   -- pedido-sem-horario
    v_txt := coalesce(d -> 'oferta_pendente' ->> 'texto', 'Esse horário serve para você?');
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'sim', 'rotulo', 'Sim, pode ser esse'),
                                                            jsonb_build_object('valor', 'nao', 'rotulo', 'Não posso nesse horário')));
  when 'horario' then
    v_txt := public.fluxo_t('horario', ctx);
    if jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) > 0 then
      v_txt := public.fluxo_t('horario_proximo', jsonb_build_object('grupo', jsonb_array_length(pa.escolha_horario) + 1,
                                                                    'total', jsonb_array_length(public.agenda_grupos(public.fluxo_procs(p_conversa)))));
    end if;
    v_op := jsonb_build_object('tipo', 'calendario', 'passo', p_passo, 'grupo', jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) + 1,
      'acoes', jsonb_build_array(jsonb_build_object('valor', 'sem_horario', 'rotulo', 'Nenhum horário serve para mim')));
  when 'mudou' then
    v_txt := public.fluxo_t('mudou', ctx);
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(jsonb_build_object('valor', 'igual', 'rotulo', 'Não, continuam os mesmos'),
                                                            jsonb_build_object('valor', 'mudou', 'rotulo', 'Sim, algo mudou')));
  when 'cpf_confirma' then   -- klingo-auto: paciente conhecido confirma só o CPF
    v_txt := replace(public.fluxo_t('cpf_confirma', ctx), '{nome}', coalesce(', ' || nullif(initcap(split_part(coalesce(v_dig ->> 'nome', ''), ' ', 1)), ''), ''));
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'pular', 'Não sou eu', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'cpf', 'rotulo', 'Digite o seu CPF', 'tipo', 'cpf', 'obrigatorio', true)));
  when 'cpf_nasc' then   -- klingo-auto
    v_txt := public.fluxo_t('cpf_nasc', ctx);
    -- sem-repetir: a 1ª mensagem ("Olá, ...! Para começar, informe o CPF...") já pede a mesma coisa; não manda o segundo texto igual
    if p_prefixo is not null and p_prefixo = public.fluxo_t(case when (ctx ->> 'filho')::boolean then 'ola_cpf_filho' else 'ola_cpf_proprio' end, ctx) then
      v_txt := p_prefixo; v_pref := null;
    end if;
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'cpf', 'rotulo', case when (ctx ->> 'filho')::boolean then 'CPF da criança (ou do responsável, se ela não tiver)' else 'CPF' end,
                         'tipo', 'cpf', 'obrigatorio', true, 'valor', v_dig ->> 'cpf'),
      jsonb_build_object('nome', 'dt_nasc', 'rotulo', 'Data de nascimento' || (ctx ->> 'de_quem'), 'tipo', 'data', 'obrigatorio', true, 'valor', v_dig ->> 'dt_nasc')));
  when 'dados_ident' then
    -- sem-repetir: CPF e nascimento já foram pedidos (e conferidos) no passo cpf_nasc; o nome da mãe deixou de ser pedido. Aqui só nome e sexo.
    v_nome := coalesce(v_dig ->> 'nome', case when v_nse then null when (ctx ->> 'filho')::boolean then c.paciente_nome else c.nome_informado end);
    v_txt := public.fluxo_t('dados_ident', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'nome', 'rotulo', 'Nome completo' || (ctx ->> 'de_quem'), 'tipo', 'texto', 'obrigatorio', true, 'valor', v_nome),
      jsonb_build_object('nome', 'sexo', 'rotulo', 'Sexo', 'tipo', 'sexo', 'obrigatorio', true, 'valor', v_dig ->> 'sexo')));
  when 'dados_contato' then
    select ct.telefone into v_tel from public.contatos ct where ct.id = c.contato_id;
    v_txt := public.fluxo_t(case when v_nse then 'nse_dados' else 'dados_contato' end, ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'campos', (case when v_nse then jsonb_build_array(jsonb_build_object('nome', 'nome', 'rotulo', 'Nome completo' || (ctx ->> 'de_quem'), 'tipo', 'texto', 'obrigatorio', true)) else '[]'::jsonb end) || jsonb_build_array(
      jsonb_build_object('nome', 'celular', 'rotulo', 'Celular (WhatsApp)', 'tipo', 'tel', 'obrigatorio', true, 'valor', coalesce(v_dig ->> 'celular', case when v_nse then null else v_tel end)),
      jsonb_build_object('nome', 'telefone', 'rotulo', 'Outro telefone', 'tipo', 'tel', 'obrigatorio', false, 'valor', v_dig ->> 'telefone'),
      jsonb_build_object('nome', 'email', 'rotulo', 'E-mail', 'tipo', 'email', 'obrigatorio', true,
        'valor', coalesce(v_dig ->> 'email', (select case when v_nse then null else coalesce(nullif(btrim(c.email_informado), ''), ct2.email) end from public.contatos ct2 where ct2.id = c.contato_id)))));
  when 'dados_endereco' then
    v_txt := public.fluxo_t('dados_endereco', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'pular', 'Não sei agora (o atendente completa)', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'cep', 'rotulo', 'CEP', 'tipo', 'cep', 'obrigatorio', false, 'valor', v_dig ->> 'cep'),
      jsonb_build_object('nome', 'endereco', 'rotulo', 'Rua', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'endereco'),
      jsonb_build_object('nome', 'numero', 'rotulo', 'Número', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'numero'),
      jsonb_build_object('nome', 'complemento', 'rotulo', 'Complemento', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'complemento'),
      jsonb_build_object('nome', 'bairro', 'rotulo', 'Bairro', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'bairro'),
      jsonb_build_object('nome', 'cidade', 'rotulo', 'Cidade', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'cidade'),
      jsonb_build_object('nome', 'uf', 'rotulo', 'UF', 'tipo', 'uf', 'obrigatorio', false, 'valor', v_dig ->> 'uf')));
  when 'dados_carteira' then
    v_txt := public.fluxo_t('dados_carteira', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'pular', 'Não estou com a carteirinha agora', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'matricula', 'rotulo', 'Número da carteirinha (' || coalesce(initcap(lower(pa.plano)), 'convênio') || ')', 'tipo', 'texto', 'obrigatorio', false, 'valor', v_dig ->> 'matricula'),
      jsonb_build_object('nome', 'validade', 'rotulo', 'Validade', 'tipo', 'data', 'obrigatorio', false, 'valor', v_dig ->> 'validade')));
  when 'confirmar' then
    v_txt := public.fluxo_t('confirmar', ctx || jsonb_build_object('resumo', public.fluxo_leitura(p_conversa)));
    v_it := jsonb_build_array(jsonb_build_object('valor', 'ok', 'rotulo', 'Está tudo certo'),
      jsonb_build_object('valor', 'pedido', 'rotulo', case when pa.tipo = 'consulta' then 'Corrigir a consulta' else 'Corrigir o exame' end),
      jsonb_build_object('valor', 'plano', 'rotulo', 'Corrigir o plano'));
    if jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) > 0 then v_it := v_it || jsonb_build_object('valor', 'horario', 'rotulo', 'Corrigir o horário'); end if;
    v_it := v_it || jsonb_build_object('valor', 'dados', 'rotulo', 'Corrigir os dados do cadastro');
    v_op := public.fluxo_escolha(p_passo, v_it);
  else
    return;
  end case;

  if v_pref is not null and btrim(v_pref) <> '' then v_txt := btrim(v_pref) || E'\n\n' || v_txt; end if;
  if p_passo in ('motivo', 'plano', 'assunto') and jsonb_typeof(v_op -> 'itens') = 'array' then v_op := jsonb_set(v_op, '{itens}', public.fluxo_ordenar(p_passo, v_op -> 'itens')); end if;
  perform public.fluxo_dizer(p_conversa, v_txt, v_op);
  update public.conversa_fluxo set tentativas = case when passo is distinct from p_passo then 0 else tentativas end, passo = p_passo, atualizado_em = now()
  where conversa_id = p_conversa;
  v_etapa := case when p_passo in ('motivo','exame','consulta','atalho','medico') then 'pedido' when p_passo in ('plano', 'plano_confirma', 'cpf_nasc', 'cpf_confirma') then 'plano' when p_passo = 'horario' then 'data_hora'
                  when p_passo in ('mudou','dados_ident','dados_contato','dados_endereco','dados_carteira','identidade') then 'dados' when p_passo = 'confirmar' then 'confirmacao' end;
  if v_etapa is not null then update public.pre_agendamentos set etapa = v_etapa where conversa_id = p_conversa and status = 'rascunho'; end if;
end $function$;

CREATE OR REPLACE FUNCTION public.fluxo_aplicar(p_conversa uuid, p_passo text, p_valor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v text := case when jsonb_typeof(p_valor) = 'string' then p_valor #>> '{}' else null end;
  o jsonb := case when jsonb_typeof(p_valor) = 'object' then p_valor else '{}'::jsonb end;
  c public.conversas; pa public.pre_agendamentos; ctx jsonb := public.fluxo_ctx(p_conversa);
  v_n int; v_dt date; v_pac jsonb := '{}'::jsonb; v_err text[] := '{}'; v_ok boolean; v_med text[]; k text; x text; v_uni text;
begin
  select * into c from public.conversas where id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  case p_passo
  when 'identidade' then
    if coalesce((o ->> 'pular')::boolean, false) then perform public.fluxo_set(p_conversa, '{"identidade_feita": true}'); return '{"ok": true}'; end if;
    v_dt := public.fluxo_ler_data(o ->> 'dt_nasc');
    if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then return jsonb_build_object('ok', false, 'erro', public.fluxo_t('identidade_erro')); end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', jsonb_build_object('dt_nasc', v_dt::text)));
    perform public.fluxo_set(p_conversa, jsonb_build_object('identidade_feita', true, 'digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb) || jsonb_build_object('dt_nasc', to_char(v_dt, 'DD/MM/YYYY'))));
  when 'cpf_confirma' then   -- klingo-auto
    if coalesce((o ->> 'pular')::boolean, false) then perform public.klingo_nao_sou_eu(p_conversa); return '{"ok": true}'::jsonb; end if;
    x := regexp_replace(coalesce(o ->> 'cpf', ''), '\D', '', 'g');
    if public.fluxo_cpf_ok(x) and x = regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g') then
      perform public.fluxo_set(p_conversa, '{"cpf_confirmado": true}');
    else
      select coalesce((f.dados ->> 'cpf_tentativas')::int, 0) + 1 into v_n from public.conversa_fluxo f where f.conversa_id = p_conversa;
      if v_n >= 3 then perform public.klingo_nao_sou_eu(p_conversa); return '{"ok": true}'::jsonb; end if;
      perform public.fluxo_set(p_conversa, jsonb_build_object('cpf_tentativas', v_n));
      return jsonb_build_object('ok', false, 'erro', 'Esse CPF não confere com o cadastro. Confira os números e tente de novo, ou toque em "Não sou eu".');
    end if;
  when 'cpf_nasc' then   -- klingo-auto
    x := regexp_replace(coalesce(o ->> 'cpf', ''), '\D', '', 'g');
    v_dt := public.fluxo_ler_data(o ->> 'dt_nasc');
    if not public.fluxo_cpf_ok(x) then v_err := array_append(v_err, 'o CPF (os números não conferem)'::text); end if;
    if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then v_err := array_append(v_err, 'a data de nascimento'::text); end if;
    if cardinality(v_err) > 0 then return jsonb_build_object('ok', false, 'erro', public.fluxo_t('dados_erro', jsonb_build_object('erros', array_to_string(v_err, ' e ')))); end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', jsonb_build_object('cpf', x, 'dt_nasc', v_dt::text)));
    perform public.fluxo_set(p_conversa, jsonb_build_object('digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb)
                                                             || jsonb_build_object('cpf', x, 'dt_nasc', to_char(v_dt, 'DD/MM/YYYY')), 'cpf_nasc_refazer', null));
  when 'atalho' then
    if v in ('ultimo', 'pendente') then
      -- convenio-quem-volta: o convênio da vez anterior não é copiado; vira pergunta ("plano_confirma").
      x := case v when 'ultimo' then public.paciente_historico_para_ia(p_conversa) -> 'ultimas' -> 0 ->> 'plano'
                  else (select o2.plano from public.pre_agendamentos o2 where o2.conversa_id = public.pre_pendencia_anterior(p_conversa)) end;
      v_ok := public.pre_reaproveitar(p_conversa, v);
      if v_ok and nullif(btrim(coalesce(x, '')), '') is not null and public.convenio_ativo(x) then   -- convenios-e-foto: convênio desativado depois não vira pergunta
        perform public.fluxo_set(p_conversa, jsonb_build_object('plano_anterior', left(btrim(x), 120)));
      end if;
      if v_ok then perform public.fluxo_set(p_conversa, '{"motivo": "exame"}');
      else return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('atalho_falhou')); end if;
    elsif v is distinct from 'outro' then return '{"ok": false}';
    end if;
  when 'motivo' then
    if v not in ('exame', 'consulta', 'assunto') then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('motivo', v));
    if v = 'consulta' then
      select u.chave into v_uni from public.unidade_config u
       where u.ativo and u.fluxo = case when (ctx ->> 'filho')::boolean then 'pediatria' else 'exame_consulta' end order by u.ordem limit 1;
      update public.conversas set unidade_inicial = v_uni where id = p_conversa;
    elsif v = 'exame' then
      update public.conversas set unidade_inicial = null where id = p_conversa;
    end if;
  when 'medico' then
    v_med := public.fluxo_medicos(p_conversa);
    if coalesce(v, '') <> '' and not (v = any(coalesce(v_med, '{}'))) then return '{"ok": false}'; end if;
    update public.conversas set medico_preferido = nullif(v, '') where id = p_conversa;
    if coalesce(v, '') <> '' then perform public.fluxo_pre(p_conversa, jsonb_build_object('profissional', v)); end if;
    perform public.fluxo_set(p_conversa, '{"medico_feito": true}');
  when 'assunto' then
    if coalesce(v, '') = '' then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('assunto', left(v, 60)));
    perform public.fluxo_marc_iniciar(p_conversa, left(v, 60));   -- v2.1: ver, cancelar e remarcar consultam o Klingo
  when 'exame_aberto', 'remarcar_falta' then
    return public.fluxo_pos_aplicar(p_conversa, p_passo, v);
  when 'marc_consultando', 'marc_lista', 'marc_acao', 'marc_cancelar', 'marc_vazio', 'marc_pos', 'resultado_situacao', 'resultado_orientacao' then   -- v2.1
    return public.fluxo_marc_aplicar(p_conversa, p_passo, v);
  when 'assunto_qual', 'assunto_confirma', 'assunto_resultado' then
    return public.fluxo_assunto_aplicar(p_conversa, p_passo, v);
  when 'assunto_texto' then
    x := btrim(coalesce(v, o ->> 'texto', ''));
    if x = '' then return '{"ok": false}'; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', left(x, 500)));
    return '{"ok": true, "transferir": true}';
  when 'plano' then
    x := btrim(coalesce(v, o ->> 'outro', ''));
    -- convenios-e-foto: convênio desativado pela gestão não é aceito; a pessoa escolhe outro, Particular ou o atendente.
    if x <> '' and not public.convenio_ativo(x) then
      return jsonb_build_object('ok', false, 'erro', public.convenio_msg(x, 'inativo'));
    end if;
    if x = '' then return '{"ok": false}'; end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('plano', left(x, 120), 'etapa', 'plano'));
    perform public.fluxo_set(p_conversa, '{"plano_anterior": null}');
    perform public.convenio_avisar(p_conversa, x);   -- convenios-e-foto: aviso e regra "um exame por vez"
    -- convenio-quem-volta: corrigiu o plano na confirmação e escolheu OUTRO convênio: a carteirinha antiga não vale mais.
    select dados ->> 'plano_trocado_de' into k from public.conversa_fluxo where conversa_id = p_conversa;
    if k is not null then
      perform public.fluxo_set(p_conversa, '{"plano_trocado_de": null}');
      if lower(btrim(k)) is distinct from lower(btrim(left(x, 120))) then
        perform public.fluxo_set(p_conversa, jsonb_build_object('g_carteira', false, 'confirmado', false,
          'digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb) - 'matricula' - 'validade'));
        if jsonb_array_length(coalesce(pa.escolha_horario, '[]'::jsonb)) > 0 then
          perform public.fluxo_nota(p_conversa, 'Convênio trocado de ' || k || ' para ' || left(x, 120) || ' depois de escolher o horário: conferir se o médico/unidade atende o convênio novo');
          if o ->> 'outro' is null then return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('plano_trocado_horario')); end if;
        elsif o ->> 'outro' is null then
          return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('plano_trocado'));
        end if;
      end if;
    end if;
    if o ->> 'outro' is not null then
      perform public.fluxo_nota(p_conversa, 'Convênio digitado pelo paciente (fora da lista): ' || x);
      perform public.fluxo_set(p_conversa, '{"confirmado": false}');
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('plano_outro', jsonb_build_object('plano', left(x, 120))));
    end if;
  when 'plano_confirma' then
    select dados ->> 'plano_anterior' into x from public.conversa_fluxo where conversa_id = p_conversa;
    if v = 'sim' then
      if x is not null then perform public.fluxo_pre(p_conversa, jsonb_build_object('plano', x, 'etapa', 'plano')); end if;
      perform public.fluxo_set(p_conversa, '{"plano_anterior": null}');
    elsif v = 'nao' then
      perform public.fluxo_set(p_conversa, '{"plano_anterior": null}');
    else return '{"ok": false}'; end if;
  when 'previsao_turno', 'previsao_periodo', 'previsao_decide', 'previsao_antecedencia' then   -- pedido-previsao
    return public.previsao_responder(p_conversa, p_passo, v);
  when 'horario_oferta' then   -- pedido-sem-horario
    declare v_p jsonb; v_n int; v_s jsonb; v_livre boolean := false; v_aviso text; v_chave text;
    begin
      select dados -> 'oferta_pendente' into v_p from public.conversa_fluxo where conversa_id = p_conversa;
      if jsonb_typeof(v_p) is distinct from 'object' or v not in ('sim', 'nao') then return '{"ok": false}'::jsonb; end if;
      v_n := coalesce((v_p ->> 'n')::int, 1); v_s := v_p -> 'slots' -> (v_n - 1);
      if v = 'sim' and v_s is not null then
        perform set_config('app.conversa', p_conversa::text, true);
        select o.chave into v_chave from public.klingo_oferta o where o.conversa_id = p_conversa and not o.sombra and o.expira_em > now() and o.data = (v_s ->> 'data')::date and o.hora = v_s ->> 'hora' and (o.data + o.hora::time) > (now() at time zone 'America/Bahia') order by o.id limit 1;
        v_livre := v_chave is not null;   -- v2.1: vale só o que a API ainda oferece (a grade não é vaga)
        if coalesce(v_livre, false) then
          update public.pre_agendamentos set escolha_horario = jsonb_build_array(jsonb_build_object('grupo', 1, 'data', v_s ->> 'data', 'hora', v_s ->> 'hora', 'unidade', v_s ->> 'unidade', 'profissional', v_s ->> 'profissional',
                                         'local', v_s ->> 'local', 'min', coalesce((v_s ->> 'min')::int, 30), 'chegada', coalesce((v_s ->> 'chegada')::boolean, false), 'origem', 'klingo_api', 'klingo_chave', v_chave)),
            data_desejada = (v_s ->> 'data')::date, hora_desejada = v_s ->> 'hora', unidade = coalesce(unidade, v_s ->> 'unidade'), etapa = 'confirmacao', atualizado_em = now()
           where conversa_id = p_conversa;
          perform public.fluxo_set(p_conversa, jsonb_build_object('oferta_pendente', null, 'sem_horario', false, 'confirmado', true, 'previsao', null));
          perform public.fluxo_nota(p_conversa, 'Paciente aceitou o horário oferecido pelo assistente: ' || (v_s ->> 'data') || ' ' || (v_s ->> 'hora') || '.');
          return jsonb_build_object('ok', true, 'aviso', 'Combinado! Troquei o horário do seu pedido.');
        end if;
        v_aviso := 'Esse horário acabou de ser ocupado.';
      end if;
      v_s := v_p -> 'slots' -> v_n;   -- índice v_n (0-based) = o próximo da lista
      if v_s is not null and v_n < 2 then
        perform public.fluxo_set(p_conversa, jsonb_build_object('oferta_pendente', v_p || jsonb_build_object('n', v_n + 1, 'texto', public.pedido_oferta_texto(v_s, v_n + 1, v_p ->> 'original'))));
        return jsonb_build_object('ok', true, 'aviso', v_aviso);
      end if;
      if public.previsao_ativa(p_conversa) then return public.previsao_iniciar(p_conversa, coalesce(v_p ->> 'origem', '') = 'previsao', v_aviso); end if;   -- pedido-previsao
      perform public.fluxo_set(p_conversa, jsonb_build_object('oferta_pendente', null, 'sem_horario', false, 'confirmado', false));
      update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null, etapa = 'data_hora' where conversa_id = p_conversa;
      perform public.fluxo_nota(p_conversa, 'Paciente não pôde nos horários oferecidos: pediu-se que escolha data e hora no calendário.');
      return jsonb_build_object('ok', true, 'aviso', coalesce(v_aviso || ' ', '') || coalesce((select valor from public.config where chave = 'pedido_escolha_texto'), ''));
    end;
  when 'horario' then
    if v = 'sem_horario' and public.previsao_ativa(p_conversa) then return public.previsao_iniciar(p_conversa, false); end if;   -- pedido-previsao
    if v = 'sem_horario' then
      perform public.fluxo_set(p_conversa, '{"sem_horario": true}');
      perform public.fluxo_nota(p_conversa, 'Nenhum horário do calendário serviu: procurar outro com o paciente');
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('horario_nenhum'));
    end if;
    return '{"ok": false}';
  when 'mudou' then
    if v = 'igual' then perform public.fluxo_set(p_conversa, '{"mudou": "igual", "g_ident": true, "g_contato": true, "g_endereco": true}');
    elsif v = 'mudou' then perform public.fluxo_set(p_conversa, '{"mudou": "mudou"}');
    else return '{"ok": false}'; end if;
  when 'dados_ident', 'dados_contato', 'dados_endereco', 'dados_carteira' then
    if coalesce((o ->> 'pular')::boolean, false) and p_passo in ('dados_endereco', 'dados_carteira') then
      perform public.fluxo_set(p_conversa, jsonb_build_object(case p_passo when 'dados_endereco' then 'g_endereco' else 'g_carteira' end, true));
      perform public.fluxo_nota(p_conversa, case p_passo when 'dados_endereco' then 'Endereço não informado' else 'Carteirinha não informada' end);
      return '{"ok": true}';
    end if;
    foreach k in array case p_passo
        when 'dados_ident' then array['nome','sexo','dt_nasc','cpf','mae']
        when 'dados_contato' then array['nome','celular','telefone','email']
        when 'dados_endereco' then array['cep','endereco','numero','complemento','bairro','cidade','uf']
        else array['matricula','validade'] end loop
      x := nullif(btrim(coalesce(o ->> k, '')), '');
      if x is null then continue; end if;
      if k in ('dt_nasc', 'validade') then
        v_dt := public.fluxo_ler_data(x);
        if v_dt is null or (k = 'dt_nasc' and (v_dt > current_date or v_dt < date '1900-01-01')) then
          v_err := array_append(v_err, case k when 'dt_nasc' then 'a data de nascimento' else 'a validade' end); continue;
        end if;
        x := v_dt::text;
      elsif k = 'cpf' then
        if not public.fluxo_cpf_ok(x) then v_err := array_append(v_err, 'o CPF (os números não conferem)'::text); continue; end if;
      elsif k = 'email' then
        x := lower(x);
        if not public.fluxo_email_ok(x) then v_err := array_append(v_err, 'o e-mail'::text); continue; end if;
        if x !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_err := array_append(v_err, 'o e-mail'::text); continue; end if;
      elsif k in ('celular', 'telefone') then
        x := regexp_replace(x, '\D', '', 'g');
        if not public.fluxo_telefone_ok(x) then v_err := array_append(v_err, case k when 'celular' then 'o celular (DDD + número)' else 'o outro telefone' end); continue; end if;
      elsif k = 'cep' then
        x := regexp_replace(x, '\D', '', 'g');
        if length(x) <> 8 then v_err := array_append(v_err, 'o CEP (8 números)'::text); continue; end if;
      elsif k = 'sexo' then
        x := upper(left(x, 1));
        if x not in ('M', 'F') then v_err := array_append(v_err, 'o sexo'::text); continue; end if;
      elsif k = 'uf' then
        x := upper(left(x, 2));
      elsif k in ('nome', 'mae') and not public.fluxo_nome_ok(x) then
        v_err := array_append(v_err, case k when 'mae' then 'o nome da mãe' else 'o nome completo' end); continue;
      end if;
      v_pac := v_pac || jsonb_build_object(k, left(x, 200));
    end loop;
    if p_passo = 'dados_ident' then
      if v_pac ->> 'nome' is null and not ('o nome completo' = any(v_err)) then v_err := array_append(v_err, 'o nome completo'::text); end if;
      if v_pac ->> 'sexo' is null and not ('o sexo' = any(v_err)) then v_err := array_append(v_err, 'o sexo'::text); end if;
      if v_pac ->> 'dt_nasc' is null and public.fluxo_ler_data(pa.paciente ->> 'dt_nasc') is null and not ('a data de nascimento' = any(v_err)) then v_err := array_append(v_err, 'a data de nascimento'::text); end if;   -- sem-repetir: já veio do cpf_nasc
      if v_pac ->> 'cpf' is null and not public.fluxo_cpf_ok(pa.paciente ->> 'cpf') and not ('o CPF (os números não conferem)' = any(v_err)) then v_err := array_append(v_err, 'o CPF'::text); end if;   -- sem-repetir: já veio do cpf_nasc
    elsif p_passo = 'dados_contato' and v_pac ->> 'celular' is null and not ('o celular (DDD + número)' = any(v_err)) then
      v_err := array_append(v_err, 'o celular (DDD + número)'::text);
    end if;
    if p_passo = 'dados_contato' and v_pac ->> 'nome' is null and coalesce((select (f.dados ->> 'nao_sou_eu')::boolean from public.conversa_fluxo f where f.conversa_id = p_conversa), false) and not ('o nome completo' = any(v_err)) then v_err := array_append(v_err, 'o nome completo'::text); end if;
    if cardinality(v_err) > 0 then
      return jsonb_build_object('ok', false, 'erro', public.fluxo_t('dados_erro', jsonb_build_object('erros', array_to_string(v_err, ', '))));
    end if;
    if v_pac <> '{}'::jsonb then perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', v_pac, 'etapa', 'dados')); end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object(case p_passo when 'dados_ident' then 'g_ident' when 'dados_contato' then 'g_contato'
                                                             when 'dados_endereco' then 'g_endereco' else 'g_carteira' end, true,
      'digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb) || (o - 'pular')));
  when 'confirmar' then
    if v = 'ok' then perform public.fluxo_set(p_conversa, '{"confirmado": true}');
    elsif v = 'pedido' then perform public.fluxo_set(p_conversa, '{"refazer": "pedido", "confirmado": false}');
    elsif v = 'plano' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('plano_trocado_de', pa.plano, 'plano_anterior', null, 'confirmado', false));
      update public.pre_agendamentos set plano = null where conversa_id = p_conversa;
    elsif v = 'horario' then
      update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null where conversa_id = p_conversa;
      perform public.fluxo_set(p_conversa, '{"confirmado": false, "sem_horario": false}');
    elsif v = 'dados' then perform public.fluxo_set(p_conversa, '{"confirmado": false, "mudou": "mudou", "g_ident": false, "g_contato": false, "g_endereco": false, "g_carteira": false}');
    else return '{"ok": false}'; end if;
  else
    return '{"ok": false}';
  end case;
  return '{"ok": true}';
end $function$;

CREATE OR REPLACE FUNCTION public.fluxo_voltar_passo(p_conversa uuid, p_op integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare d jsonb; v_motivo text;
begin
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb); v_motivo := d ->> 'motivo';
  case p_op
  when 1 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "g_carteira": false}');
  when 2 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "g_contato": false, "g_endereco": false}');
  when 3 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "g_ident": false}');
  when 4 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "mudou": null}');
  when 5 then
    update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null where conversa_id = p_conversa and status = 'rascunho';
    perform public.fluxo_set(p_conversa, '{"confirmado": false, "sem_horario": false}');
  when 6 then
    perform public.fluxo_set(p_conversa, jsonb_build_object('confirmado', false, 'plano_anterior', null, 'plano_trocado_de', null));
    update public.pre_agendamentos set plano = null where conversa_id = p_conversa and status = 'rascunho';
  when 7 then
    perform public.fluxo_set(p_conversa, '{"confirmado": false, "medico_feito": false}');
    update public.conversas set medico_preferido = null where id = p_conversa;
  when 8 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "refazer": "pedido"}');
  when 9 then
    if v_motivo = 'assunto' then perform public.fluxo_set(p_conversa, '{"assunto": null}'); end if;
  when 11 then perform public.fluxo_set(p_conversa, '{"confirmado": false, "cpf_nasc_refazer": true}');   -- klingo-auto
  when 10 then
    perform public.fluxo_set(p_conversa, '{"confirmado": false, "motivo": null, "refazer": null, "medico_feito": false, "assunto": null}');
    update public.pre_agendamento_itens set ativo = false where conversa_id = p_conversa and ativo;
    update public.conversas set unidade_inicial = null, medico_preferido = null where id = p_conversa;
  else null;
  end case;
end $function$;

CREATE OR REPLACE FUNCTION public.fluxo_leitura(p_conversa uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa public.pre_agendamentos; c public.conversas; d jsonb; p jsonb; v text[] := '{}'; x text; v_dias text[] := array['dom','seg','ter','qua','qui','sex','sáb'];
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select * into c from public.conversas where id = p_conversa;
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  p := coalesce(d -> 'digitado', '{}'::jsonb);
  select string_agg('• ' || coalesce(public.fluxo_rotulo_item(p_conversa, i.procedimento_id, i.procedimento, i.modalidade), 'o atendente define o exame')
                    || case i.lado when 'D' then ' — lado direito' when 'E' then ' — lado esquerdo' when 'A' then ' — os dois lados' else '' end, E'\n' order by i.id)
    into x from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo;
  if x is not null then v := v || (case when pa.tipo = 'consulta' then 'Consulta:' else 'Exames:' end || E'\n' || x); end if;
  if pa.profissional is not null then v := v || ('Médico: ' || initcap(lower(pa.profissional))); end if;
  v := v || ('Plano: ' || coalesce(initcap(lower(pa.plano)), '—'));
  select string_agg(v_dias[extract(dow from (e ->> 'data')::date)::int + 1] || ' ' || to_char((e ->> 'data')::date, 'DD/MM') || ' às ' || (e ->> 'hora')
                    || coalesce(' — ' || regexp_replace(e ->> 'unidade', '^CLÍNICA DE SAÚDE E IMAGEM - ', 'CSI '), ''), E'\n' order by (e ->> 'grupo')::int)
    into x from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e;
  v := v || ('Horário (previsão): ' || coalesce(x, 'o atendente combina com você'));
  v := v || ('Paciente: ' || coalesce(p ->> 'nome', case when c.paciente_tipo = 'filho' then c.paciente_nome else c.nome_informado end, '—')
             || coalesce(', nascimento ' || (p ->> 'dt_nasc'), ''));
  if d ->> 'mudou' = 'igual' then v := v || 'Cadastro: os mesmos dados da última vez'::text; end if;
  if p ->> 'cpf' is not null then v := v || ('CPF: ' || (p ->> 'cpf')); end if;
  if p ->> 'mae' is not null then v := v || ('Mãe: ' || (p ->> 'mae')); end if;
  if p ->> 'celular' is not null then v := v || ('Celular: ' || (p ->> 'celular')); end if;
  if p ->> 'email' is not null then v := v || ('E-mail: ' || (p ->> 'email')); end if;
  if p ->> 'endereco' is not null or p ->> 'cep' is not null then
    v := v || ('Endereço: ' || concat_ws(', ', p ->> 'endereco', p ->> 'numero', p ->> 'complemento', p ->> 'bairro', p ->> 'cidade', upper(p ->> 'uf'), p ->> 'cep'));
  end if;
  if p ->> 'matricula' is not null then v := v || ('Carteirinha: ' || (p ->> 'matricula') || coalesce(' (validade ' || (p ->> 'validade') || ')', '')); end if;
  return array_to_string(v, E'\n');
end $function$;

CREATE OR REPLACE FUNCTION public.fluxo_ler_texto(p_conversa uuid, p_passo text, p_texto text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare t text := public.fluxo_norm(p_texto); v_dt date; x text; v_med text[];
  sim boolean := t ~ '^(sim|s|isso|isso mesmo|pode|ok|okay|claro|correto|certo|confirmo|esta certo|ta certo|tudo certo|exato|positivo|uhum|aham)\M';
  nao boolean := t ~ '^(nao|n|negativo|errado|nada disso)\M';
begin
  case p_passo
  when 'identidade' then
    v_dt := public.fluxo_ler_data(p_texto);
    if v_dt is not null then return jsonb_build_object('dt_nasc', v_dt::text); end if;
  when 'motivo' then
    if t ~ '(exame|resson|reson|tomograf|ultras|ultrason|raio|\mrx\M|\mrm\M|\mtc\M|\musg?\M|mamograf|densitom|eletro|\mecg\M|\meeg\M|doppler|ecocard)' then return '"exame"'; end if;
    if t ~ '(consulta|medic|doutor|\mdra?\M|pediatr|cardiolog|ginecolog|ortoped|neuro|endocrin|gastro|urolog|nutri|puericult)' then return '"consulta"'; end if;
    if t ~ '(remarc|cancel|desmarc|resultado|laudo|duvida|reclama|minha marcacao|minhas marcacoes|meu agendamento|meus agendamentos)' then return '"assunto"'; end if;
  when 'atalho' then
    if t ~ '(repetir|mesmo|ultimo)' then return '"ultimo"'; end if;
    if t ~ '(continuar|metade|pendente)' then return '"pendente"'; end if;
    if t ~ '(outro|novo|nova|diferente)' then return '"outro"'; end if;
  when 'assunto' then
    if t ~ '(minha marcacao|minhas marcacoes|meu agendamento|meus agendamentos|ver (a |as )?(minha|minhas|meu|meus))' then return '"Minhas marcações"'; end if;   -- v2.1
    if t ~ '(remarc|mudar (o )?(dia|horario))' then return '"Remarcar"'; end if;
    if t ~ '(cancel|desmarc)' then return '"Cancelar"'; end if;
    if t ~ '(resultado|laudo)' then return '"Resultado de exame"'; end if;
    if t ~ '(reclama|sugest)' then return '"Reclamação"'; end if;
    if t ~ '(duvida|pergunta)' then return '"Dúvida"'; end if;
  when 'exame_aberto' then
    if t ~ '(cancel|desmarc)' then return '"cancelar"'; end if;
    if t ~ '(remarc|outro dia|outra data)' then return '"remarcar"'; end if;
    if t ~ '(nao (fui|consegui|pude|compareci|fiz)|faltei|perdi)' then return '"faltei"'; end if;
    if t ~ '(^|\m)(fui|fiz|compareci|realizei|feito)' then return '"compareceu"'; end if;
  when 'remarcar_falta' then
    if t ~ '(atendente|pessoa|humano|ligar)' then return '"atendente"'; end if;
    if nao or t ~ '(nao quero|desisti|deixa)' then return '"nao"'; end if;
    if sim or t ~ '(remarc|quero)' then return '"sim"'; end if;
  when 'marc_acao', 'marc_cancelar', 'marc_vazio', 'marc_pos' then   -- v2.1
    if p_passo = 'marc_cancelar' then
      if sim then return '"cancelar_sim"'; end if;
      if nao then return '"cancelar_nao"'; end if;
    end if;
    if p_passo = 'marc_acao' and t ~ '(cancel|desmarc)' then return '"cancelar"'; end if;
    if p_passo = 'marc_acao' and t ~ '(remarc|outro dia|outra data|mudar)' then return '"remarcar"'; end if;
    if p_passo = 'marc_acao' and t ~ '(outra marcacao|outro agendamento|ver outra)' then return '"outra"'; end if;
    if t ~ '(atendente|pessoa|humano|equipe)' then return '"equipe"'; end if;
    if p_passo in ('marc_vazio', 'marc_pos') and t ~ '(nova marcacao|marcar|agendar|novo)' then return '"nova"'; end if;
    if p_passo = 'marc_pos' and t ~ '(ver|consultar|minhas)' then return '"ver"'; end if;
    if p_passo <> 'marc_cancelar' and t ~ '(obrigad|tudo certo|era so isso|so isso)' then return '"fim"'; end if;
  when 'resultado_situacao' then
    if t ~ '(pronto|saiu|liberad)' then return '"pronto"'; end if;
    if t ~ '(link|senha|acesso|site)' then return '"acesso"'; end if;
    if t ~ '(problema|erro|errado|trocado)' then return '"problema"'; end if;
    if t ~ '(atendente|pessoa|humano|equipe)' then return '"equipe"'; end if;
  when 'resultado_orientacao' then
    if t ~ '(atendente|pessoa|humano|equipe)' or nao then return '"equipe"'; end if;
    if sim or t ~ '(obrigad|resolv|valeu)' then return '"resolvido"'; end if;
  when 'assunto_confirma' then
    if sim then return '"sim"'; end if;
    if nao then return '"nao"'; end if;
  when 'assunto_resultado' then
    if sim or t ~ '(resolv|obrigad|valeu|deu certo)' then return '"resolvido"'; end if;
    if nao then return '"atendente"'; end if;
  when 'assunto_texto' then
    return jsonb_build_object('texto', left(btrim(p_texto), 500));
  when 'plano' then
    if t ~ '(particular|sem (plano|convenio)|nao tenho (plano|convenio))' then return '"Particular"'; end if;
    select q.operadora into x from (
      select o.operadora,
             count(*) filter (where t ~ ('\m' || w || '\M')) as acertos,
             count(*) filter (where t ~ ('\m' || w || '\M') and w !~ '^(saude|plano|planos|hospital|seguros|seguro|operadora|central|nacional|assistencia|vida|sa)$') as fortes
      from (select distinct operadora from public.catalogo_plano where coalesce(ativo, true) and operadora !~* '^(teste|particular)$') o
      cross join lateral unnest(string_to_array(regexp_replace(public.fluxo_norm(o.operadora), '[^a-z0-9 ]', ' ', 'g'), ' ')) w
      where length(w) >= 3
      group by o.operadora) q
    where q.fortes > 0 order by q.acertos desc, length(q.operadora) limit 1;
    if x is not null then return to_jsonb(x); end if;
  when 'plano_confirma' then
    if t ~ '(nao (mudou|mudei|mudaram|trocou|troquei)|nada mudou|continua|continuo)' then return '"sim"'; end if;
    if nao or t ~ '(mudou|mudei|mudaram|trocou|troquei|outro|novo|nova|diferente)' then return '"nao"'; end if;
    if sim or t ~ '(mesmo|igual)' then return '"sim"'; end if;
  when 'medico' then
    if t ~ '(tanto faz|qualquer|sem preferencia|nao tenho preferencia|nenhum)' then return '""'; end if;
    v_med := public.fluxo_medicos(p_conversa);
    select m into x from unnest(v_med) m where public.fluxo_norm(m) ~ ('\m' || split_part(t, ' ', 1)) and length(split_part(t, ' ', 1)) >= 3 limit 1;
    if x is not null then return to_jsonb(x); end if;
  when 'mudou' then
    if t ~ '(continua|mesmo|igual|nao mudou|nada mudou)' or nao then return '"igual"'; end if;
    if t ~ '(mudou|mudei|mudaram|novo|nova)' or sim then return '"mudou"'; end if;
  when 'confirmar' then
    if sim then return '"ok"'; end if;
  when 'horario' then
    if t ~ '(nenhum|nao (serve|da|consigo)|outro horario|outra data)' then return '"sem_horario"'; end if;
  else
    null;
  end case;
  return null;
end $function$;

delete from public.fluxo_texto where chave = 'plano_exato';
delete from public.config where chave = 'plano_exato_modo';
-- por último (as funções acima já não as chamam): drop function public.plano_exato_chave(uuid); drop function public.plano_exato_itens(integer); drop function public.plano_exato_convenio(text);
