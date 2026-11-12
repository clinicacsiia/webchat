-- Autoatendimento com a API do Klingo — Parte 4b: o motor do chat conhece os passos novos. Escrito em 12/11/2026.
--
-- FLUXOGRAMA: motivo -> exame/consulta -> médico -> cpf_nasc (NOVO: CPF + nascimento obrigatórios) -> plano -> horário (com a API, só horários que o Klingo também oferece; sem ela, a grade como sempre)
--   -> dados -> confirmar -> fluxo_finalizar: se klingo_pode_marcar, cria a operação e diz "marcando…" (passo marcando); senão entrega o pedido à equipe como sempre (fluxo_finalizar_humano).
--   Depois da marcação: passo pos_menu (ver a marcação, falar com a equipe, está tudo certo).
-- Versão 1.0 — 12/11/2026 / Mudança: primeira versão. Cada função abaixo parte do código REAL da produção (supabase/producao/funcoes/) e muda só o marcado com "-- klingo-auto".
-- Para voltar atrás: recolocar as funções de supabase/producao/funcoes/ (fluxo_proximo, fluxo_perguntar, fluxo_aplicar, fluxo_finalizar, fluxo_avancar, fluxo_resumo, chat_horarios, chat_horario_escolher)
--   e update public.config set valor = 'nao' where chave in ('klingo_api_horarios','klingo_api_marcar').

insert into public.fluxo_texto (chave, texto) values
  ('pos_menu', 'Posso ajudar em mais alguma coisa com essa marcação?'),
  ('pos_menu_texto', 'Estou por aqui. O que você precisa agora?'),
  ('pos_fim', 'Perfeito! Até breve, e obrigado por escolher a clínica. 💙'),
  ('pos_equipe', 'Tudo bem, vou chamar uma pessoa da equipe para te ajudar.')
on conflict (chave) do nothing;

-- A API de horários vale para esta conversa? (modo "sim" ou telefone de teste)
create or replace function public.klingo_horarios_api_ativa(p_conversa uuid) returns boolean
language sql stable security definer set search_path to '' as $$ select public.klingo_ativo(p_conversa, 'klingo_api_horarios') $$;

-- Passo do menu depois da marcação
create or replace function public.fluxo_pos_menu(p_conversa uuid, p_texto text default null) returns void
language plpgsql security definer set search_path to '' as $$
begin
  update public.conversa_fluxo set passo = 'pos_menu', atualizado_em = now() where conversa_id = p_conversa;
  perform public.fluxo_dizer(p_conversa, coalesce(p_texto, public.fluxo_t('pos_menu', public.fluxo_ctx(p_conversa))), public.fluxo_escolha('pos_menu', jsonb_build_array(
    jsonb_build_object('valor', 'ver', 'rotulo', 'Ver a minha marcação'),
    jsonb_build_object('valor', 'equipe', 'rotulo', 'Remarcar, cancelar ou falar com a equipe'),
    jsonb_build_object('valor', 'fim', 'rotulo', 'Está tudo certo, obrigado'))));
end $$;

create or replace function public.fluxo_pos_responder(p_conversa uuid, p_valor text) returns void
language plpgsql security definer set search_path to '' as $$
declare pa public.pre_agendamentos; e jsonb; v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado']; v_txt text; ctx jsonb := public.fluxo_ctx(p_conversa);
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if p_valor = 'ver' then
    e := pa.escolha_horario -> 0;
    v_txt := coalesce(nullif(e ->> 'procedimento', ''), 'Atendimento') || E'\n' || v_dias[extract(dow from (e ->> 'data')::date)::int + 1] || ', ' || to_char((e ->> 'data')::date, 'DD/MM') || ' às ' || (e ->> 'hora')
             || coalesce(E'\n' || nullif(e ->> 'unidade', ''), '') || coalesce(E'\nCom ' || nullif(e ->> 'profissional', ''), '') || coalesce(E'\nProtocolo: ' || pa.klingo_marcacoes[1], '');
    perform public.fluxo_pos_menu(p_conversa, 'Sua marcação:' || E'\n' || v_txt);
  elsif p_valor = 'equipe' then
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('pos_equipe', ctx));
    perform public.fluxo_transferir(p_conversa, 'Paciente quer remarcar, cancelar ou falar com a equipe depois da marcação automática.', 'baixa', true);
  else
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('pos_fim', ctx), jsonb_build_object('tipo', 'nova'));
    update public.conversa_fluxo set passo = 'marcado', atualizado_em = now() where conversa_id = p_conversa;
  end if;
end $$;

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
  if not public.fluxo_cpf_ok(pa.paciente ->> 'cpf') or public.fluxo_ler_data(pa.paciente ->> 'dt_nasc') is null then return 'cpf_nasc'; end if;
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
  v_etapa text;
begin
  select * into c from public.conversas where id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb); v_dig := coalesce(pa.paciente, '{}'::jsonb) || coalesce(d -> 'digitado', '{}'::jsonb);

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
    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'Remarcar', 'rotulo', 'Remarcar um horário'), jsonb_build_object('valor', 'Cancelar', 'rotulo', 'Cancelar um horário'),
      jsonb_build_object('valor', 'Resultado de exame', 'rotulo', 'Resultado de exame'), jsonb_build_object('valor', 'Dúvida', 'rotulo', 'Tirar uma dúvida'),
      jsonb_build_object('valor', 'Reclamação', 'rotulo', 'Reclamação ou sugestão'), jsonb_build_object('valor', 'Outro', 'rotulo', 'Outro assunto')));
  when 'exame_aberto', 'remarcar_falta' then
    v_op := public.fluxo_pos_pergunta(p_conversa, p_passo);
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
  when 'cpf_nasc' then   -- klingo-auto
    v_txt := public.fluxo_t('cpf_nasc', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'cpf', 'rotulo', case when (ctx ->> 'filho')::boolean then 'CPF da criança (ou do responsável, se ela não tiver)' else 'CPF' end,
                         'tipo', 'cpf', 'obrigatorio', true, 'valor', v_dig ->> 'cpf'),
      jsonb_build_object('nome', 'dt_nasc', 'rotulo', 'Data de nascimento' || (ctx ->> 'de_quem'), 'tipo', 'data', 'obrigatorio', true, 'valor', v_dig ->> 'dt_nasc')));
  when 'dados_ident' then
    v_nome := coalesce(v_dig ->> 'nome', case when (ctx ->> 'filho')::boolean then c.paciente_nome else c.nome_informado end);
    v_txt := public.fluxo_t('dados_ident', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'nome', 'rotulo', 'Nome completo' || (ctx ->> 'de_quem'), 'tipo', 'texto', 'obrigatorio', true, 'valor', v_nome),
      jsonb_build_object('nome', 'sexo', 'rotulo', 'Sexo', 'tipo', 'sexo', 'obrigatorio', true, 'valor', v_dig ->> 'sexo'),
      jsonb_build_object('nome', 'dt_nasc', 'rotulo', 'Data de nascimento', 'tipo', 'data', 'obrigatorio', true, 'valor', v_dig ->> 'dt_nasc'),
      jsonb_build_object('nome', 'cpf', 'rotulo', case when (ctx ->> 'filho')::boolean then 'CPF da criança (ou do responsável, se ela não tiver)' else 'CPF' end,
                         'tipo', 'cpf', 'obrigatorio', true, 'valor', v_dig ->> 'cpf')));   -- klingo-auto: CPF obrigatório
  when 'dados_contato' then
    select ct.telefone into v_tel from public.contatos ct where ct.id = c.contato_id;
    v_txt := public.fluxo_t('dados_contato', ctx);
    v_op := jsonb_build_object('tipo', 'campos', 'passo', p_passo, 'botao', 'Continuar', 'campos', jsonb_build_array(
      jsonb_build_object('nome', 'celular', 'rotulo', 'Celular (WhatsApp)', 'tipo', 'tel', 'obrigatorio', true, 'valor', coalesce(v_dig ->> 'celular', v_tel)),
      jsonb_build_object('nome', 'telefone', 'rotulo', 'Outro telefone', 'tipo', 'tel', 'obrigatorio', false, 'valor', v_dig ->> 'telefone'),
      jsonb_build_object('nome', 'email', 'rotulo', 'E-mail', 'tipo', 'email', 'obrigatorio', true,
        'valor', coalesce(v_dig ->> 'email', (select coalesce(nullif(btrim(c.email_informado), ''), ct2.email) from public.contatos ct2 where ct2.id = c.contato_id)))));
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

  if p_prefixo is not null and btrim(p_prefixo) <> '' then v_txt := btrim(p_prefixo) || E'\n\n' || v_txt; end if;
  perform public.fluxo_dizer(p_conversa, v_txt, v_op);
  update public.conversa_fluxo set tentativas = case when passo is distinct from p_passo then 0 else tentativas end, passo = p_passo, atualizado_em = now()
  where conversa_id = p_conversa;
  v_etapa := case when p_passo in ('motivo','exame','consulta','atalho','medico') then 'pedido' when p_passo in ('plano', 'plano_confirma', 'cpf_nasc') then 'plano' when p_passo = 'horario' then 'data_hora'
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
  v_dt date; v_pac jsonb := '{}'::jsonb; v_err text[] := '{}'; v_ok boolean; v_med text[]; k text; x text; v_uni text;
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
  when 'cpf_nasc' then   -- klingo-auto
    x := regexp_replace(coalesce(o ->> 'cpf', ''), '\D', '', 'g');
    v_dt := public.fluxo_ler_data(o ->> 'dt_nasc');
    if not public.fluxo_cpf_ok(x) then v_err := array_append(v_err, 'o CPF (os números não conferem)'::text); end if;
    if v_dt is null or v_dt > current_date or v_dt < date '1900-01-01' then v_err := array_append(v_err, 'a data de nascimento'::text); end if;
    if cardinality(v_err) > 0 then return jsonb_build_object('ok', false, 'erro', public.fluxo_t('dados_erro', jsonb_build_object('erros', array_to_string(v_err, ' e ')))); end if;
    perform public.fluxo_pre(p_conversa, jsonb_build_object('paciente', jsonb_build_object('cpf', x, 'dt_nasc', v_dt::text)));
    perform public.fluxo_set(p_conversa, jsonb_build_object('digitado', coalesce((select dados -> 'digitado' from public.conversa_fluxo where conversa_id = p_conversa), '{}'::jsonb)
                                                             || jsonb_build_object('cpf', x, 'dt_nasc', to_char(v_dt, 'DD/MM/YYYY'))));
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
  when 'exame_aberto', 'remarcar_falta' then
    return public.fluxo_pos_aplicar(p_conversa, p_passo, v);
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
  when 'horario' then
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
        when 'dados_ident' then array['nome','sexo','dt_nasc','cpf']
        when 'dados_contato' then array['celular','telefone','email']
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
        if x !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_err := array_append(v_err, 'o e-mail'::text); continue; end if;
      elsif k in ('celular', 'telefone') then
        x := regexp_replace(x, '\D', '', 'g');
        if length(x) not in (10, 11) then v_err := array_append(v_err, case k when 'celular' then 'o celular (DDD + número)' else 'o outro telefone' end); continue; end if;
      elsif k = 'cep' then
        x := regexp_replace(x, '\D', '', 'g');
        if length(x) <> 8 then v_err := array_append(v_err, 'o CEP (8 números)'::text); continue; end if;
      elsif k = 'sexo' then
        x := upper(left(x, 1));
        if x not in ('M', 'F') then v_err := array_append(v_err, 'o sexo'::text); continue; end if;
      elsif k = 'uf' then
        x := upper(left(x, 2));
      elsif k = 'nome' and length(x) < 5 then
        v_err := array_append(v_err, 'o nome completo'::text); continue;
      end if;
      v_pac := v_pac || jsonb_build_object(k, left(x, 200));
    end loop;
    if p_passo = 'dados_ident' then
      if v_pac ->> 'nome' is null and not ('o nome completo' = any(v_err)) then v_err := array_append(v_err, 'o nome completo'::text); end if;
      if v_pac ->> 'sexo' is null and not ('o sexo' = any(v_err)) then v_err := array_append(v_err, 'o sexo'::text); end if;
      if v_pac ->> 'dt_nasc' is null and not ('a data de nascimento' = any(v_err)) then v_err := array_append(v_err, 'a data de nascimento'::text); end if;
      if v_pac ->> 'cpf' is null and not ('o CPF (os números não conferem)' = any(v_err)) then v_err := array_append(v_err, 'o CPF'::text); end if;
    elsif p_passo = 'dados_contato' and v_pac ->> 'celular' is null and not ('o celular (DDD + número)' = any(v_err)) then
      v_err := array_append(v_err, 'o celular (DDD + número)'::text);
    end if;
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

create or replace function public.fluxo_finalizar(p_conversa uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare ctx jsonb := public.fluxo_ctx(p_conversa); v_pode jsonb; v_op uuid;
begin
  begin v_pode := public.klingo_pode_marcar(p_conversa); exception when others then v_pode := jsonb_build_object('ok', false, 'motivo', 'erro_interno'); end;
  if coalesce((v_pode ->> 'ok')::boolean, false) then
    begin
      v_op := public.klingo_operacao_criar(p_conversa);
      update public.conversa_fluxo set passo = 'marcando', dados = dados || jsonb_build_object('enviado_em', now(), 'operacao', v_op), atualizado_em = now() where conversa_id = p_conversa;
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('marcando', ctx), jsonb_build_object('tipo', 'marcando', 'operacao', v_op));
      return;
    exception when others then null;   -- qualquer falha aqui: segue o caminho de sempre (pedido para a equipe)
    end;
  end if;
  perform public.fluxo_finalizar_humano(p_conversa, case when coalesce(v_pode ->> 'motivo', 'desligado') in ('desligado', 'ja_agendado') then null else 'Automação não aplicada: ' || (v_pode ->> 'motivo') end);
end $$;

CREATE OR REPLACE FUNCTION public.fluxo_avancar(p_conversa uuid, p_entrada jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c public.conversas; f public.conversa_fluxo; v_t0 timestamptz := clock_timestamp();
  v_passo text; v_valor jsonb := p_entrada -> 'valor'; v_texto text := btrim(coalesce(p_entrada ->> 'texto', ''));
  v_norm text; v_res jsonb; v_prox text; v_prefixo text; v_tipo text := 'texto'; v_entendeu boolean := true; ctx jsonb;
begin
  select * into c from public.conversas where id = p_conversa for update;
  if not found or c.motor <> 'fluxo' or not (c.ia_ativa and c.status = 'aguardando') then return; end if;
  insert into public.conversa_fluxo (conversa_id) values (p_conversa) on conflict (conversa_id) do nothing;
  select * into f from public.conversa_fluxo where conversa_id = p_conversa for update;
  v_passo := f.passo;
  ctx := public.fluxo_ctx(p_conversa);

  if v_passo is null then
    v_prefixo := public.fluxo_t(case when (ctx ->> 'filho')::boolean then 'ola_filho' else 'ola_proprio' end, ctx);
    v_tipo := 'inicio';
  elsif v_passo in ('pronto', 'humano', 'assunto_fim') then
    perform public.fluxo_dizer(p_conversa, public.fluxo_t('reaberta', ctx), jsonb_build_object('tipo', 'nova'));
    perform public.fluxo_transferir(p_conversa, 'Paciente voltou a escrever depois do atendimento.', 'baixa', false);
    insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'reaberta', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
    return;
  elsif p_entrada ->> 'acao' = 'atendente' then
    perform public.fluxo_transferir(p_conversa, 'Paciente pediu para falar com um atendente.', 'media', true);
    insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'atendente', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
    return;
  elsif p_entrada ->> 'evento' = 'anexo' then
    return;
  elsif v_valor is not null then
    v_tipo := 'botao';
    if p_entrada ->> 'passo' is distinct from v_passo then return; end if;
  elsif v_texto ~ '^(Pedido de exames:|Pedido de consulta:)' then
    v_tipo := 'componente';
    perform public.fluxo_set(p_conversa, jsonb_build_object('motivo', case when v_texto like 'Pedido de consulta:%' then 'consulta' else 'exame' end,
                                                            'confirmado', false, 'refazer', null, 'medico_feito', false));
    update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null
     where conversa_id = p_conversa and escolha_horario is not null and status = 'rascunho';   -- convenio-quem-volta: exame ou consulta
  elsif v_texto ~ '^(Horário \d+ de \d+: )?Escolhi ' then
    v_tipo := 'componente';
    perform public.fluxo_set(p_conversa, '{"confirmado": false}');
  elsif v_texto like 'Agora vamos agendar para %' then
    v_tipo := 'componente';
  else
    v_norm := public.fluxo_norm(v_texto);
    if v_norm ~ '(dor (muito )?(forte |intensa )?no peito|aperto no peito|falta de ar|nao consigo respirar|dificuldade (para|pra) respirar|desmai|sangramento (intenso|forte|muito)|sangrando muito|\mavc\M|derrame|boca torta|convuls|reacao alergica|anafila|garganta fechando|quero morrer|me matar|suicid|me machucar|tirar (a )?minha vida|febre (alta|muito alta)|desidrat|sangue nas fezes|sangue no vomito|vomitando sangue|inconsciente|nao acorda|engasgad|nao (esta|ta) respirando)' then
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('emergencia', ctx));
      perform public.fluxo_transferir(p_conversa, 'URGENTE: possível emergência descrita pelo paciente: "' || left(v_texto, 200) || '"', 'alta', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'emergencia', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    if v_norm ~ '(\matendente\M|\mhumano\M|recepcionista|secretaria|falar com (alguem|uma pessoa|pessoa|a clinica|voces)|pessoa de verdade|\mpessoa real\M)' then
      perform public.fluxo_transferir(p_conversa, 'Paciente pediu para falar com um atendente.', 'media', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'atendente', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    -- klingo-auto: texto livre enquanto a marcação roda ou depois dela
    if v_passo = 'marcando' then
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('marcado_aguarde', ctx));
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'texto', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    elsif v_passo in ('marcado', 'pos_menu') then
      perform public.fluxo_pos_menu(p_conversa, public.fluxo_t('pos_menu_texto', ctx));
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'texto', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    if v_passo is distinct from 'assunto_texto' then
      if v_norm ~ '(quanto custa|quanto (e|fica|sai)|qual (o )?valor|\mvalor\M|\mpreco|\mcusta\M|orcamento)' then
        v_prefixo := coalesce(public.preco_previsao_chat(p_conversa), public.fluxo_t('preco', ctx)); v_prox := v_passo;
      elsif v_norm ~ '(diagnostic|remedio|medicament|posso tomar|o que (pode ser|eu tenho|ele tem|ela tem)|e grave|tratamento|dosagem|\mdose\M)' then
        v_prefixo := public.fluxo_t('clinico', ctx); v_prox := v_passo;
      end if;
    end if;
    if v_prox is null then
      v_valor := public.fluxo_ler_texto(p_conversa, v_passo, v_texto);
      if v_valor is null and v_passo = 'exame' then
        perform public.fluxo_set(p_conversa, jsonb_build_object('termo', left(v_texto, 80)));
        v_prefixo := 'Veja se o seu exame está nesta lista:'; v_prox := v_passo;
      elsif v_valor is null then
        v_entendeu := false;
        perform public.fluxo_nota(p_conversa, 'Paciente escreveu (não entendido no passo ' || coalesce(v_passo, '-') || '): ' || left(v_texto, 200));
        update public.conversa_fluxo set tentativas = tentativas + 1 where conversa_id = p_conversa;
        v_prefixo := public.fluxo_t('nao_entendi', ctx); v_prox := v_passo;
      end if;
    end if;
  end if;

  if v_valor is not null and v_prox is null then
    if v_passo = 'pos_menu' then   -- klingo-auto: menu depois da marcação
      perform public.fluxo_pos_responder(p_conversa, case when jsonb_typeof(v_valor) = 'string' then v_valor #>> '{}' end);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, 'botao', true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    end if;
    v_res := public.fluxo_aplicar(p_conversa, v_passo, v_valor);
    if not coalesce((v_res ->> 'ok')::boolean, false) then
      v_entendeu := false;
      v_prefixo := coalesce(v_res ->> 'erro', public.fluxo_t('nao_entendi', ctx)); v_prox := v_passo;
    elsif coalesce((v_res ->> 'transferir')::boolean, false) then
      perform public.fluxo_transferir(p_conversa, 'Outro assunto: ' || coalesce((select dados ->> 'assunto' from public.conversa_fluxo where conversa_id = p_conversa), ''), 'baixa', true);
      insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, v_tipo, true, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
      return;
    else
      v_prefixo := v_res ->> 'aviso';
    end if;
  end if;

  if v_prox is null then v_prox := public.fluxo_proximo(p_conversa); end if;
  if v_prox = 'pronto' then
    perform public.fluxo_finalizar(p_conversa);
  elsif v_prox = 'horario' and v_tipo = 'componente' and v_passo = 'horario' then
    perform public.fluxo_perguntar(p_conversa, v_prox, null);
  else
    perform public.fluxo_perguntar(p_conversa, v_prox, v_prefixo);
  end if;
  insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente)
  values (p_conversa, coalesce(v_passo, 'inicio'), v_tipo, v_entendeu, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> 'ms')::int);
end $function$;

CREATE OR REPLACE FUNCTION public.fluxo_resumo(p_conversa uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare pa public.pre_agendamentos; d jsonb; v text[] := '{}'; x text;
begin
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  select dados into d from public.conversa_fluxo where conversa_id = p_conversa;
  d := coalesce(d, '{}'::jsonb);
  select string_agg(coalesce(public.fluxo_rotulo_item(p_conversa, i.procedimento_id, i.procedimento, i.modalidade), i.modalidade) || case i.lado when 'D' then ' (D)' when 'E' then ' (E)' when 'A' then ' (ambos)' else '' end, ' + ' order by i.id)
    into x from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo;
  if x is not null then v := v || ('Pedido: ' || x); end if;
  if pa.plano is not null then v := v || ('Plano: ' || pa.plano); end if;
  if pa.profissional is not null then v := v || ('Médico: ' || pa.profissional); end if;
  select string_agg(to_char((e ->> 'data')::date, 'DD/MM') || ' ' || (e ->> 'hora') || coalesce(' ' || regexp_replace(e ->> 'unidade', '^CLÍNICA DE SAÚDE E IMAGEM - ', ''), ''), '; ' order by (e ->> 'grupo')::int)
    into x from jsonb_array_elements(coalesce(pa.escolha_horario, '[]'::jsonb)) e;
  if x is not null then v := v || ('Horário escolhido (previsão): ' || x); end if;
  if pa.identidade is not null then v := v || ('Cadastro: ' || case pa.identidade when 'conferida' then 'paciente conhecido, data de nascimento conferida'
      when 'divergente' then 'data de nascimento NÃO conferiu' when 'atualizar' then 'conhecido, atualizar dados' when 'aguardando' then 'aguardando conferência' else 'paciente novo' end); end if;
  if d ->> 'assunto' is not null then v := v || ('Assunto: ' || (d ->> 'assunto') || coalesce(' — ' || (d ->> 'assunto_texto'), '')); end if;
  select 'Marcação automática: ' || o.estado || coalesce(' (' || o.codigo || ')', '') || coalesce(' — voucher ' || o.voucher_id, '') into x   -- klingo-auto
    from public.klingo_operacao o where o.conversa_id = p_conversa order by o.criado_em desc limit 1;
  if x is not null then v := v || x; end if;
  select string_agg(n, ' | ') into x from jsonb_array_elements_text(coalesce(d -> 'notas', '[]'::jsonb)) n;
  if x is not null then v := v || ('Observações: ' || x); end if;
  return array_to_string(v, E'\n');
end $function$;

CREATE OR REPLACE FUNCTION public.chat_horarios(p_conversa uuid, p_token text, p_grupo integer DEFAULT 1, p_de date DEFAULT NULL::date, p_ate date DEFAULT NULL::date, p_unidade text DEFAULT NULL::text, p_periodo text DEFAULT NULL::text, p_excluir jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_procs int[]; v_grupos jsonb; v_g jsonb; v_de date := coalesce(p_de, current_date); v_ate date; v_meta timestamptz; v_dias jsonb; v_unid jsonb; v_sem int; v_escolhas jsonb; v_titulo text; v_jan jsonb; v_pref text; v_med text; v_med_sem boolean := false; v_sug jsonb; v_api boolean := false;   -- klingo-auto
begin
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  v_ate := least(coalesce(p_ate, v_de + 30), v_de + 45);
  select array_agg(i.procedimento_id order by i.id) into v_procs from public.pre_agendamento_itens i,
    lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  select count(*) into v_sem from public.pre_agendamento_itens where conversa_id = p_conversa and ativo and procedimento_id is null;
  if v_procs is null then
    return jsonb_build_object('grupos', '[]'::jsonb, 'sem_exame', v_sem, 'dias', '[]'::jsonb, 'aviso', 'Escolha o exame primeiro para ver os horários.');
  end if;
  v_grupos := public.agenda_grupos(v_procs);
  select jsonb_agg(jsonb_build_object('indice', t.ord, 'procs', t.g -> 'procs',
      'nomes', (select jsonb_agg(distinct p.nome) from jsonb_array_elements_text(t.g -> 'procs') x join public.catalogo_procedimento p on p.id = x::int)) order by t.ord)
    into v_grupos from jsonb_array_elements(v_grupos) with ordinality t(g, ord);
  v_g := v_grupos -> (greatest(p_grupo, 1) - 1);
  if v_g is null then raise exception 'Grupo inexistente.' using errcode = '22023'; end if;
  select array_agg(x::int) into v_procs from jsonb_array_elements_text(v_g -> 'procs') x;
  select escolha_horario into v_escolhas from public.pre_agendamentos where conversa_id = p_conversa;
  select m.atualizado_em into v_meta from public.agenda_ocupacao_meta m where m.id = 1;

  -- klingo-auto: com a API ligada para esta conversa, só aparecem os horários que o Klingo também oferece agora (as regras locais continuam valendo por cima)
  v_api := cardinality(v_procs) = 1 and public.klingo_horarios_api_ativa(p_conversa)
           and exists (select 1 from public.klingo_oferta o where o.conversa_id = p_conversa and o.expira_em > now());
  select c.medico_preferido into v_pref from public.conversas c where c.id = p_conversa;
  v_med := v_pref;
  if v_med is not null and not exists (select 1 from public.agenda_horarios(v_procs, v_de, v_ate, p_unidade, v_med, p_periodo, '[]'::jsonb)) then
    v_med := null; v_med_sem := true;
  end if;
  with h0 as (select * from public.agenda_horarios(v_procs, v_de, v_ate, p_unidade, v_med, p_periodo, coalesce(p_excluir, '[]'::jsonb) || coalesce((select jsonb_agg(jsonb_build_object('data', e ->> 'data', 'hora', e ->> 'hora', 'min', coalesce((e ->> 'min')::int, 30), 'unidade', e ->> 'unidade')) from jsonb_array_elements(coalesce(v_escolhas, '[]'::jsonb)) e where (e ->> 'grupo')::int <> greatest(p_grupo, 1)), '[]'::jsonb))),
  h as (select h0.* from h0 where not v_api or exists (select 1 from public.klingo_oferta o where o.conversa_id = p_conversa and o.expira_em > now() and o.data = h0.data and o.hora = h0.hora and public.klingo_prof_confere(o.profissional, h0.profissional))),
  um as (select distinct on (h.data, h.hora) h.* from h order by h.data, h.hora, h.profissional)
  select coalesce(jsonb_agg(jsonb_build_object('data', d.data, 'slots', d.slots) order by d.data), '[]'::jsonb) into v_dias
  from (select um.data, jsonb_agg(jsonb_build_object('hora', um.hora, 'unidade', um.unidade, 'profissional', um.profissional, 'local', um.local, 'min', um.duracao_min, 'chegada', um.chegada) order by um.hora) slots
        from um group by um.data) d;
  select jsonb_build_object('data', s.data, 'hora', s.hora, 'unidade', s.unidade, 'profissional', s.profissional, 'apos', pc.paciente_nome) into v_sug
  from public.conversas c join public.conversas pc on pc.id = c.irmao_de
  join public.pre_agendamentos pp on pp.conversa_id = pc.id and jsonb_typeof(pp.escolha_horario) = 'array'
  cross join lateral (select e from jsonb_array_elements(pp.escolha_horario) e where (e ->> 'grupo')::int = greatest(p_grupo, 1) limit 1) pe
  cross join lateral (select d.data, sl ->> 'hora' as hora, sl ->> 'unidade' as unidade, sl ->> 'profissional' as profissional
      from jsonb_to_recordset(v_dias) as d(data date, slots jsonb), jsonb_array_elements(d.slots) sl
      where d.data = (pe.e ->> 'data')::date
        and (sl ->> 'hora')::time >= (pe.e ->> 'hora')::time + make_interval(mins => coalesce((pe.e ->> 'min')::int, 30))
      order by ((sl ->> 'profissional') = (pe.e ->> 'profissional')) desc, sl ->> 'hora' limit 1) s
  where c.id = p_conversa and c.irmaos_modo = 'juntos';
  select coalesce(jsonb_agg(distinct a.unidade), '[]'::jsonb) into v_unid from public.catalogo_agenda a
    where a.procedimento_id = any(v_procs) and a.vig_fim >= current_date and a.profissional !~* 'teste';

  select coalesce(jsonb_object_agg(j.dia_num::text, jsonb_build_object('ini', j.ini, 'fim', j.fim, 'passo', j.passo)), '{}'::jsonb) into v_jan from (
    select a.dia_num, min(a.hora_ini) as ini, max(a.hora_fim) as fim, min(a.duracao_min) filter (where a.duracao_min > 5) as passo
    from public.catalogo_agenda a join public.catalogo_procedimento pm on pm.id = a.procedimento_id
    left join public.agenda_modalidade_local ml on ml.modalidade = pm.modalidade
    where a.procedimento_id = any(v_procs) and a.vig_fim >= v_de and a.vig_ini <= v_ate and a.profissional !~* 'teste'
      and (ml.local_padrao is null or a.local ~* ml.local_padrao) and (a.duracao_min > 5 or a.hora_fim::time - a.hora_ini::time >= interval '60 minutes')
      and (p_unidade is null or public.norm_nome(a.unidade) = public.norm_nome(p_unidade))
    group by a.dia_num) j;
  return jsonb_build_object('janelas', v_jan, 'grupos', v_grupos, 'grupo', greatest(p_grupo, 1), 'de', v_de, 'ate', v_ate, 'dias', v_dias, 'unidades', v_unid,
    'escolhas', coalesce(v_escolhas, '[]'::jsonb), 'sem_exame', v_sem, 'medico_preferido', v_pref, 'medico_filtrando', v_med is not null, 'medico_sem_horario', v_med_sem, 'sugerido', v_sug, 'atualizado_em', v_meta, 'klingo_api', v_api,
    'aviso', case when v_api then null when v_meta is null then 'Horários calculados pela grade de atendimento; o atendente confirma a disponibilidade.'
                  when v_meta < now() - interval '60 minutes' then 'Os horários podem ter mudado nos últimos minutos; o atendente confirma.' else null end);
end $function$;

CREATE OR REPLACE FUNCTION public.chat_horario_escolher(p_conversa uuid, p_token text, p_grupo integer, p_data date, p_hora text, p_unidade text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_procs int[]; v_grupos jsonb; v_g jsonb; v_row record; v_escolhas jsonb; v_outros jsonb; v_novo jsonb; v_total int; v_feitos int; v_txt text; v_msg bigint;
  v_api boolean := false; v_chave text; v_conf boolean := false;   -- klingo-auto
  v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
begin
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  if p_data is null or p_hora !~ '^\d{2}:\d{2}$' or p_data < current_date or p_data > current_date + 60 then raise exception 'Data inválida.' using errcode = '22023'; end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  perform pg_advisory_xact_lock(hashtext('agenda:' || p_data::text));
  select array_agg(i.procedimento_id order by i.id) into v_procs from public.pre_agendamento_itens i,
    lateral generate_series(1, i.quantidade) g where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  if v_procs is null then raise exception 'Escolha o exame primeiro.' using errcode = '22023'; end if;
  v_grupos := public.agenda_grupos(v_procs);
  v_total := jsonb_array_length(v_grupos);
  v_g := v_grupos -> (greatest(p_grupo, 1) - 1);
  if v_g is null then raise exception 'Grupo inexistente.' using errcode = '22023'; end if;
  select array_agg(x::int) into v_procs from jsonb_array_elements_text(v_g -> 'procs') x;

  select coalesce(escolha_horario, '[]'::jsonb) into v_escolhas from public.pre_agendamentos where conversa_id = p_conversa;
  v_escolhas := coalesce(v_escolhas, '[]'::jsonb);
  select coalesce(jsonb_agg(e), '[]'::jsonb) into v_outros from jsonb_array_elements(v_escolhas) e where (e ->> 'grupo')::int <> greatest(p_grupo, 1);

  v_api := cardinality(v_procs) = 1 and public.klingo_horarios_api_ativa(p_conversa)
           and exists (select 1 from public.klingo_oferta o where o.conversa_id = p_conversa and o.expira_em > now());   -- klingo-auto
  -- confere de novo agora: o horário pode ter sido ocupado enquanto o paciente decidia
  select * into v_row from public.agenda_horarios(v_procs, p_data, p_data, p_unidade, null, null,
        (select coalesce(jsonb_agg(jsonb_build_object('data', e ->> 'data', 'hora', e ->> 'hora', 'min', coalesce((e ->> 'min')::int, 30), 'unidade', e ->> 'unidade')), '[]'::jsonb) from jsonb_array_elements(v_outros) e))
      h where h.hora = p_hora
        and (not v_api or exists (select 1 from public.klingo_oferta o where o.conversa_id = p_conversa and o.expira_em > now() and o.data = p_data and o.hora = h.hora and public.klingo_prof_confere(o.profissional, h.profissional)))
      order by h.profissional limit 1;
  if v_row.hora is null then raise exception 'Esse horário acabou de ficar indisponível. Escolha outro, por favor.' using errcode = 'P0002'; end if;

  if v_api then   -- klingo-auto: guarda a chave do horário que a API ofereceu
    select o.chave into v_chave from public.klingo_oferta o where o.conversa_id = p_conversa and o.expira_em > now() and o.data = p_data and o.hora = v_row.hora
       and public.klingo_prof_confere(o.profissional, v_row.profissional) order by o.id limit 1;
    v_conf := public.klingo_ativo(p_conversa, 'klingo_api_marcar');
  end if;
  v_novo := jsonb_build_object('grupo', greatest(p_grupo, 1), 'data', p_data, 'hora', v_row.hora, 'unidade', v_row.unidade, 'profissional', v_row.profissional,
                               'local', v_row.local, 'min', v_row.duracao_min, 'chegada', v_row.chegada) || case when v_chave is not null then jsonb_build_object('klingo_chave', v_chave) else '{}'::jsonb end;
  v_escolhas := v_outros || jsonb_build_array(v_novo);
  v_feitos := jsonb_array_length(v_escolhas);

  update public.pre_agendamentos set escolha_horario = v_escolhas,
    data_desejada = (select (e ->> 'data')::date from jsonb_array_elements(v_escolhas) e order by (e ->> 'grupo')::int limit 1),
    hora_desejada = (select e ->> 'hora' from jsonb_array_elements(v_escolhas) e order by (e ->> 'grupo')::int limit 1),
    unidade = coalesce(unidade, v_row.unidade),
    etapa = case when v_feitos >= v_total then 'dados' else 'data_hora' end, atualizado_em = now()
  where conversa_id = p_conversa and status not in ('agendado','cancelado');

  v_txt := format('Escolhi %s, %s/%s%s%s. %s',
    v_dias[extract(dow from p_data)::int + 1], to_char(p_data, 'DD'), to_char(p_data, 'MM'),
    case when v_row.chegada then ', por ordem de chegada a partir das ' || v_row.hora else ' às ' || v_row.hora end,
    case when v_row.unidade is not null then ' — ' || v_row.unidade else '' end,
    case when v_conf then '(Horário conferido agora na agenda da clínica.)' else '(Sei que é uma previsão e que o atendente confirma o dia e o horário.)' end);
  if v_total > 1 then v_txt := format('Horário %s de %s: %s', greatest(p_grupo, 1), v_total, v_txt); end if;
  update public.conversas set status = case when status = 'encerrada' then 'aguardando' else status end where id = p_conversa;
  insert into public.mensagens (conversa_id, autor, texto) values (p_conversa, 'cliente', v_txt) returning id into v_msg;
  return jsonb_build_object('ok', true, 'restantes', greatest(v_total - v_feitos, 0), 'escolha', v_novo, 'mensagem_id', v_msg);
end $function$;

do $$ declare f text; begin
  for f in select unnest(array['klingo_horarios_api_ativa(uuid)', 'fluxo_pos_menu(uuid, text)', 'fluxo_pos_responder(uuid, text)', 'fluxo_finalizar(uuid)', 'fluxo_proximo(uuid)', 'fluxo_perguntar(uuid, text, text)',
      'fluxo_aplicar(uuid, text, jsonb)', 'fluxo_avancar(uuid, jsonb)', 'fluxo_resumo(uuid)']) loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
