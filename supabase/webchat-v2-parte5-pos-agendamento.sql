-- Fluxo: Entrada (paciente identificado no chat escolhe "Ver minhas marcações", "Cancelar" ou "Remarcar") → Validação (chave do modo, CPF + nascimento do pedido, identidade e sessão conferidas pelo executor no Klingo)
--        → Processamento (operação "ler_vouchers" lista as marcações ATIVAS do próprio paciente; cancelar e remarcar só sobre uma marcação dessa lista, com a regra de 24 h)
--        → Persistência (klingo_marcacao = retrato da última consulta; klingo_operacao = histórico; pre_agendamentos só muda com confirmação do Klingo) → Saída (mensagens e botões do chat).
-- Versão 1.0 — 14/11/2026 / Mudança: primeira versão (pós-agendamento unificado: ver, cancelar, remarcar e orientação de resultado de exame).
--   • Ver minhas marcações: consulta o Klingo (GET /vouchers pela sessão do paciente); mostra também marcações feitas FORA do chat; nunca de outra pessoa.
--   • Cancelar: escolhe a marcação, regra de 24 h, confirmação, cancelamento no Klingo (DELETE /voucher) e conferência; "cancelado" só depois do OK do Klingo.
--   • Remarcar: usa o caminho que o Klingo oferece (marcar com "remarcacao": o Klingo cancela o antigo sozinho). O horário antigo só some depois do novo. Depois da marcação o executor confere o antigo:
--     ainda ativo = DOIS agendamentos (a equipe é avisada com prioridade alta); resposta perdida = conferência humana. Marcação feita fora do chat e sem o pedido original no nosso banco vai para a equipe (não dá para remarcar sem saber o serviço e o convênio).
--   • Resultado de exame: experiência completa SEM inventar endpoint: situação (pronto? link/senha? problema?) + orientação configurável + passagem para a equipe com o contexto. A integração do Klingo continua PENDENTE.
-- Depende de: webchat-v2-parte1-modos.sql (klingo_ativo, chave klingo_api_consultar). NÃO aplicada na produção.
-- Reversão: reaplicar as funções de supabase/producao/funcoes/ (fluxo_proximo, fluxo_perguntar, fluxo_aplicar, fluxo_avancar, fluxo_ler_texto, chat_voltar, klingo_operacao_concluir) e
--   `update public.config set valor = 'nao' where chave = 'klingo_api_consultar'`. A tabela klingo_marcacao pode ficar (só guarda o retrato da consulta; limpa em 7 dias).

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Retrato da última consulta de marcações (sem CPF, sem nascimento, sem nome do paciente)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.klingo_marcacao (
  id bigserial primary key,
  conversa_id uuid not null,
  voucher text not null,
  procedimento text,
  procedimento_id text,
  unidade text,
  profissional text,
  data date,
  hora text,
  situacao text not null default 'ativa',
  origem text not null default 'klingo',
  consultado_em timestamptz not null default now(),
  operacao_id uuid,
  constraint klingo_marcacao_situacao_ck check (situacao in ('ativa', 'cancelada', 'remarcada', 'nao_listada')),
  constraint klingo_marcacao_unica unique (conversa_id, voucher)
);
create index if not exists klingo_marcacao_conversa_idx on public.klingo_marcacao (conversa_id, situacao);
create index if not exists klingo_marcacao_voucher_idx on public.klingo_marcacao (voucher);
alter table public.klingo_marcacao enable row level security;
revoke all on public.klingo_marcacao from public, anon, authenticated;

-- Textos editáveis pela clínica (não sobrescreve o que já existe)
insert into public.fluxo_texto (chave, texto, descricao) values
  ('marc_consultando',   'Estou consultando as suas marcações no sistema da clínica. Leva só alguns segundos.', 'Pós-agendamento: aguardando a consulta ao Klingo'),
  ('marc_lista',         'Encontrei estas marcações ativas no cadastro{de_quem}. Qual delas você quer ver?', 'Pós-agendamento: lista de marcações'),
  ('marc_vazio',         'Não encontrei marcação ativa e futura no cadastro{de_quem}. Se você marcou há pouco, pode levar alguns minutos para aparecer. O que prefere?', 'Pós-agendamento: nada encontrado'),
  ('marc_falha',         'Não consegui consultar o sistema da clínica agora, então não posso confirmar suas marcações por aqui. Vou passar para a nossa equipe, que confere com você.', 'Pós-agendamento: Klingo indisponível'),
  ('marc_identidade',    'Não consegui confirmar os dados do cadastro para mostrar as marcações com segurança. Vou chamar a nossa equipe para conferir com você.', 'Pós-agendamento: identidade não confirmada'),
  ('marc_acao',          'O que você quer fazer com esta marcação?', 'Pós-agendamento: ações da marcação'),
  ('marc_cancelar',      'Confirma o cancelamento desta marcação? Depois de cancelada, o horário volta para a agenda da clínica.', 'Pós-agendamento: confirmação de cancelamento'),
  ('marc_cancelando',    'Cancelando no sistema da clínica… Só aviso que está cancelado depois que o sistema confirmar.', 'Pós-agendamento: cancelando'),
  ('marc_cancelado',     'Pronto: o sistema da clínica confirmou o cancelamento.', 'Pós-agendamento: cancelamento confirmado'),
  ('marc_prazo',         'Para cancelar ou remarcar com menos de {horas} horas de antecedência eu preciso da nossa equipe. Já chamei uma pessoa para te ajudar.', 'Pós-agendamento: regra de antecedência'),
  ('marc_desligado',     'Por aqui eu ainda não consigo fazer essa alteração. Vou chamar a nossa equipe para te ajudar.', 'Pós-agendamento: ação desligada'),
  ('marc_remarcar_equipe','Esta marcação não foi feita por este chat e eu não tenho como remarcá-la com segurança. Vou chamar a nossa equipe, que já recebe os dados dela.', 'Pós-agendamento: remarcação só pela equipe'),
  ('marc_remarcar_inicio','Vamos remarcar. O horário atual continua valendo até o novo ser confirmado. Escolha o novo horário:', 'Pós-agendamento: início da remarcação'),
  ('marc_pos',           'Posso ajudar em mais alguma coisa com as suas marcações?', 'Pós-agendamento: depois de uma ação'),
  ('marc_desatualizada', 'Essa marcação mudou desde a última consulta. Vou consultar de novo.', 'Pós-agendamento: lista antiga'),
  ('resultado_situacao', 'Sobre o resultado do exame, o que você precisa?', 'Resultado de exame: pergunta inicial'),
  ('resultado_consultando', 'Estou conferindo no sistema da clínica se o seu resultado já foi liberado. Leva só alguns segundos.', 'Resultado: aguardando a consulta ao Klingo'),
  ('resultado_orientacao_pronto',   'O prazo de entrega do resultado é informado no dia do exame. O acesso (link e senha) é enviado pela clínica quando o laudo é liberado; se o seu já estiver liberado e você não recebeu, a nossa equipe reenvia. Posso chamar uma pessoa agora.', 'Resultado: está pronto? (editável)'),
  ('resultado_orientacao_acesso',   'O link e a senha de acesso ao resultado são enviados pela clínica depois que o laudo é liberado. Se você ainda não recebeu, a nossa equipe confere e reenvia. Posso chamar uma pessoa agora.', 'Resultado: link e senha (editável)'),
  ('resultado_orientacao_problema', 'Sinto muito pelo transtorno. Vou passar para a nossa equipe, que olha o seu caso com prioridade.', 'Resultado: problema com o resultado (editável)')
on conflict (chave) do nothing;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. Apoios
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.klingo_marc_quando(p_data date, p_hora text) returns text
  language sql immutable set search_path to ''
as $f$ select (array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'])[extract(dow from p_data)::int + 1] || ', ' || to_char(p_data, 'DD/MM') || coalesce(' às ' || nullif(p_hora, ''), '') $f$;

create or replace function public.klingo_marc_prazo_ok(p_data date, p_hora text) returns boolean
  language sql stable security definer set search_path to ''
as $f$ select p_data is not null and ((p_data + coalesce(nullif(p_hora, ''), '00:00')::time) - (now() at time zone 'America/Bahia')) >= make_interval(hours => coalesce(nullif(public.klingo_cfg('klingo_pos_prazo_horas', '24'), '')::integer, 24)) $f$;

create or replace function public.klingo_marc_resumo(p_conversa uuid, p_voucher text) returns text
  language sql stable security definer set search_path to ''
as $f$
  select coalesce(nullif(m.procedimento, ''), 'Atendimento') || E'\n' || public.klingo_marc_quando(m.data, m.hora)
         || coalesce(E'\n' || nullif(m.unidade, ''), '') || coalesce(E'\nCom ' || nullif(m.profissional, ''), '') || E'\nProtocolo: ' || m.voucher
    from public.klingo_marcacao m where m.conversa_id = p_conversa and m.voucher = p_voucher
$f$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. Pedir a consulta (cria a operação "ler_vouchers") e aplicar o resultado
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.klingo_marcacoes_pedir(p_conversa uuid) returns uuid
  language plpgsql security definer set search_path to ''
as $f$
declare d jsonb; v_pa uuid; v_op uuid;
begin
  if not public.klingo_ativo(p_conversa, 'klingo_api_consultar') then return null; end if;
  d := public.klingo_dados_conversa(p_conversa);
  if d ->> 'cpf' is null or d ->> 'nascimento' is null then return null; end if;   -- sem CPF e nascimento válidos não há consulta
  v_pa := (d ->> 'pre_agendamento_id')::uuid;
  -- duplo toque: uma consulta em andamento (menos de 3 minutos) é reaproveitada
  select id into v_op from public.klingo_operacao where conversa_id = p_conversa and tipo = 'ler_vouchers' and estado in ('pendente', 'executando') and criado_em > now() - interval '3 minutes' order by criado_em desc limit 1;
  if v_op is null then
    insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, detalhe)
    values (p_conversa, v_pa, 'ler_vouchers', 'ler:' || p_conversa::text || ':' || gen_random_uuid()::text, '{}'::jsonb) returning id into v_op;
    perform public.klingo_operacao_disparar(v_op);
    perform public.klingo_medir('op_criada');
  end if;
  perform public.fluxo_set(p_conversa, jsonb_build_object('marc_estado', 'consultando', 'marc_op', v_op, 'marc_voucher', null, 'marc_acao', null));
  return v_op;
end $f$;

create or replace function public.klingo_marcacoes_aplicar(p_op uuid, p_estado text, p_r jsonb) returns jsonb
  language plpgsql security definer set search_path to ''
as $f$
declare
  op public.klingo_operacao; v_cod text := left(p_r ->> 'codigo', 60); v_n integer := 0; v_fut integer := 0; v_hoje date := (now() at time zone 'America/Bahia')::date; ctx jsonb; v_txt text; v_pos text;
begin
  select * into op from public.klingo_operacao where id = p_op;
  if coalesce((op.detalhe ->> 'resultado')::boolean, false) then return public.klingo_resultados_aplicar(p_op, p_estado, p_r); end if;   -- consulta de resultado de exame
  ctx := public.fluxo_ctx(op.conversa_id);
  select passo into v_pos from public.conversa_fluxo where conversa_id = op.conversa_id;
  if p_estado = 'sucesso' and jsonb_typeof(p_r -> 'marcacoes') = 'array' then
    -- o retrato novo substitui o antigo: o que não veio na lista deixa de ser "ativa"
    update public.klingo_marcacao set situacao = 'nao_listada' where conversa_id = op.conversa_id and situacao = 'ativa';
    insert into public.klingo_marcacao (conversa_id, voucher, procedimento, procedimento_id, unidade, profissional, data, hora, situacao, origem, consultado_em, operacao_id)
    select op.conversa_id, m.id, left(m.procedimento, 120), left(m."procedimentoId", 20), left(m.unidade, 120), left(m.profissional, 120),
           case when m.data ~ '^\d{4}-\d{2}-\d{2}' then substr(m.data, 1, 10)::date end, left(m.hora, 5), 'ativa',
           case when exists (select 1 from public.pre_agendamentos x where x.klingo_marcacoes @> array[m.id] and x.agendado_origem = 'chat_api') then 'chat_api' else 'klingo' end, now(), op.id
      from jsonb_to_recordset(p_r -> 'marcacoes') as m(id text, procedimento text, "procedimentoId" text, unidade text, profissional text, data text, hora text)
     where m.id ~ '^\d+$'
    on conflict (conversa_id, voucher) do update set procedimento = excluded.procedimento, procedimento_id = excluded.procedimento_id, unidade = excluded.unidade, profissional = excluded.profissional,
      data = excluded.data, hora = excluded.hora, situacao = 'ativa', origem = excluded.origem, consultado_em = now(), operacao_id = excluded.operacao_id;
    select count(*) into v_n from public.klingo_marcacao where conversa_id = op.conversa_id and situacao = 'ativa';
    select count(*) into v_fut from public.klingo_marcacao where conversa_id = op.conversa_id and situacao = 'ativa' and data >= v_hoje;
    if v_pos is distinct from 'marc_consultando' then return jsonb_build_object('ok', true, 'estado', 'sucesso', 'marcacoes', v_n); end if;   -- o paciente já saiu desse passo (ex.: foi para a equipe): só guarda o retrato
    if v_fut = 0 then
      perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'vazio'));
      perform public.fluxo_perguntar(op.conversa_id, 'marc_vazio', null);
    else
      perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'pronto', 'marc_voucher', null, 'marc_acao', null));
      perform public.fluxo_perguntar(op.conversa_id, 'marc_lista', null);
    end if;
    return jsonb_build_object('ok', true, 'estado', 'sucesso', 'marcacoes', v_n);
  end if;
  if v_pos is distinct from 'marc_consultando' then return jsonb_build_object('ok', true, 'estado', p_estado); end if;
  -- não deu para listar
  if v_cod = 'cadastro_nao_encontrado' then
    perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'vazio'));
    perform public.fluxo_perguntar(op.conversa_id, 'marc_vazio', null);
  elsif v_cod in ('nascimento_divergente', 'sessao_nao_confere', 'dados_incompletos', 'sem_id_definitivo') or v_cod like 'divergencia_%' then
    -- identidade não confirmada: não mostra nada e a equipe confere (nunca expõe o que bateu ou não)
    perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'local'));
    perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('marc_identidade', ctx));
    perform public.fluxo_transferir(op.conversa_id, 'Paciente quis ver as marcações e a identidade não foi confirmada no Klingo (' || coalesce(v_cod, 'falha') || '). Conferir com o paciente antes de mostrar qualquer dado.', 'baixa', true);
  else
    -- Klingo fora do ar / limite / resposta estranha: informa a limitação e usa só o histórico do chat (origem conhecida), marcado como possivelmente desatualizado
    perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'local'));
    v_txt := public.fluxo_t('marc_falha', ctx);
    select string_agg('• ' || (e ->> 'rotulo'), E'\n') into v_pos from jsonb_array_elements(public.fluxo_assunto_futuros(op.conversa_id)) e;
    if v_pos is not null then v_txt := v_txt || E'\n\nPelo histórico deste chat constam (pode estar desatualizado):' || E'\n' || v_pos; end if;
    perform public.fluxo_nota(op.conversa_id, 'Consulta de marcações ao Klingo não concluída (' || coalesce(v_cod, 'falha') || '). O paciente foi informado da limitação.');
    perform public.fluxo_dizer(op.conversa_id, v_txt);
    perform public.fluxo_transferir(op.conversa_id, 'Paciente quis ver, cancelar ou remarcar marcação e a consulta ao Klingo não concluiu (' || coalesce(v_cod, 'falha') || ').', 'baixa', true);
  end if;
  return jsonb_build_object('ok', true, 'estado', p_estado);
end $f$;

-- Resultado de exame: só pergunta ao Klingo se o laudo está LIBERADO (nunca guarda nem mostra o conteúdo). Fica desligado enquanto klingo_api_resultado = nao (padrão) ou sombra.
-- Limite honesto: a API entrega o laudo como arquivo (não existe link nem senha); o acesso continua sendo passado pela equipe, como decidido em 03/11/2026. Laudo liberado nunca foi testado com paciente real.
create or replace function public.klingo_resultados_pedir(p_conversa uuid) returns uuid
  language plpgsql security definer set search_path to ''
as $f$
declare d jsonb; v_op uuid;
begin
  if not public.klingo_ativo(p_conversa, 'klingo_api_resultado') then return null; end if;
  d := public.klingo_dados_conversa(p_conversa);
  if d ->> 'cpf' is null or d ->> 'nascimento' is null then return null; end if;
  select id into v_op from public.klingo_operacao where conversa_id = p_conversa and tipo = 'ler_vouchers' and estado in ('pendente', 'executando') and criado_em > now() - interval '3 minutes' and coalesce((detalhe ->> 'resultado')::boolean, false) order by criado_em desc limit 1;
  if v_op is null then
    insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, detalhe)
    values (p_conversa, (d ->> 'pre_agendamento_id')::uuid, 'ler_vouchers', 'ler:' || p_conversa::text || ':' || gen_random_uuid()::text, '{"resultado": true}'::jsonb) returning id into v_op;
    perform public.klingo_operacao_disparar(v_op);
    perform public.klingo_medir('op_criada');
  end if;
  perform public.fluxo_set(p_conversa, jsonb_build_object('resultado_estado', 'consultando', 'resultado_op', v_op));
  return v_op;
end $f$;

create or replace function public.klingo_resultados_aplicar(p_op uuid, p_estado text, p_r jsonb) returns jsonb
  language plpgsql security definer set search_path to ''
as $f$
declare op public.klingo_operacao; v_cod text := left(p_r ->> 'codigo', 60); v_pos text; v_txt text; v_lista text; ctx jsonb;
begin
  select * into op from public.klingo_operacao where id = p_op;
  ctx := public.fluxo_ctx(op.conversa_id);
  select passo into v_pos from public.conversa_fluxo where conversa_id = op.conversa_id;
  if v_pos is distinct from 'marc_consultando' then return jsonb_build_object('ok', true, 'estado', p_estado); end if;
  if p_estado = 'sucesso' and jsonb_typeof(p_r -> 'resultados') = 'array' then
    select string_agg('• ' || coalesce(nullif(x.procedimento, ''), 'Exame') || coalesce(' de ' || to_char(case when x.data ~ '^\d{4}-\d{2}-\d{2}' then substr(x.data, 1, 10)::date end, 'DD/MM'), '') || ': '
                      || case when x.pronto is true then 'resultado liberado' when x.pronto is false then 'ainda não liberado' else 'não consegui conferir' end, E'\n')
      into v_lista from jsonb_to_recordset(p_r -> 'resultados') as x(procedimento text, data text, pronto boolean);
    v_txt := case when v_lista is null then 'Não encontrei exame realizado recentemente no cadastro' || (ctx ->> 'de_quem') || '.' else 'Conferi no sistema da clínica:' || E'\n' || v_lista end;
    perform public.fluxo_set(op.conversa_id, jsonb_build_object('resultado_estado', 'mostrado'));
    perform public.fluxo_perguntar(op.conversa_id, 'resultado_orientacao', v_txt);
    return jsonb_build_object('ok', true, 'estado', 'sucesso');
  end if;
  if v_cod in ('nascimento_divergente', 'sessao_nao_confere', 'dados_incompletos', 'sem_id_definitivo', 'cadastro_nao_encontrado') or v_cod like 'divergencia_%' then
    perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('marc_identidade', ctx));
    perform public.fluxo_transferir(op.conversa_id, 'Paciente quis saber do resultado de exame e a identidade não foi confirmada no Klingo (' || coalesce(v_cod, 'falha') || ').', 'baixa', true);
    return jsonb_build_object('ok', true, 'estado', p_estado);
  end if;
  perform public.fluxo_set(op.conversa_id, jsonb_build_object('resultado_estado', 'falha'));
  perform public.fluxo_nota(op.conversa_id, 'Consulta de resultado ao Klingo não concluída (' || coalesce(v_cod, 'falha') || ').');
  perform public.fluxo_perguntar(op.conversa_id, 'resultado_orientacao', 'Não consegui conferir o sistema da clínica agora, então não sei dizer se o seu resultado já foi liberado.');
  return jsonb_build_object('ok', true, 'estado', p_estado);
end $f$;

revoke all on function public.klingo_resultados_pedir(uuid), public.klingo_resultados_aplicar(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.klingo_resultados_pedir(uuid), public.klingo_resultados_aplicar(uuid, text, jsonb) to service_role;

-- Cancelamento pedido pela lista: "cancelado" só depois do OK do Klingo; o registro local acompanha, nunca antecipa
create or replace function public.klingo_cancelamento_aplicar(p_op uuid, p_estado text, p_cod text) returns jsonb
  language plpgsql security definer set search_path to ''
as $f$
declare op public.klingo_operacao; ctx jsonb; v_vou text; v_res text; v_pos text;
begin
  select * into op from public.klingo_operacao where id = p_op;
  ctx := public.fluxo_ctx(op.conversa_id); v_vou := op.detalhe ->> 'voucher';
  select public.klingo_marc_resumo(op.conversa_id, v_vou) into v_res;
  select passo into v_pos from public.conversa_fluxo where conversa_id = op.conversa_id;
  if p_estado = 'sucesso' then
    update public.klingo_marcacao set situacao = 'cancelada', consultado_em = now() where voucher = v_vou and situacao in ('ativa', 'nao_listada');
    -- o pedido que originou essa marcação (se for do nosso chat) acompanha o Klingo; nada é apagado
    update public.pre_agendamentos set status = 'cancelado', conferencia_status = 'sumiu', conferencia_em = now(), atualizado_em = now() where klingo_marcacoes @> array[v_vou] and status = 'agendado';
    perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_estado', 'pos', 'marc_voucher', null, 'marc_acao', null));
    perform public.fluxo_perguntar(op.conversa_id, 'marc_pos', public.fluxo_t('marc_cancelado', ctx) || coalesce(E'\n\n' || v_res, ''));
    return jsonb_build_object('ok', true, 'estado', 'sucesso');
  end if;
  perform public.fluxo_set(op.conversa_id, jsonb_build_object('marc_acao', null));
  perform public.fluxo_nota(op.conversa_id, 'Cancelamento automático NÃO concluído (' || coalesce(p_cod, 'falha') || '). A marcação ' || coalesce(v_vou, '?') || ' pode continuar ATIVA no Klingo: conferir' || case when p_estado = 'incerto' then ' ANTES de qualquer nova tentativa.' else '.' end);
  perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('cancelar_equipe', ctx));
  perform public.fluxo_transferir(op.conversa_id, 'Paciente pediu para cancelar a marcação ' || coalesce(v_vou, '?') || ' e o cancelamento automático não concluiu (' || coalesce(p_cod, 'falha') || ').', case when p_estado = 'incerto' then 'media' else 'baixa' end, false);
  return jsonb_build_object('ok', true, 'estado', p_estado);
end $f$;

revoke all on function public.klingo_marc_quando(date, text), public.klingo_marc_prazo_ok(date, text), public.klingo_marc_resumo(uuid, text), public.klingo_marcacoes_pedir(uuid),
  public.klingo_marcacoes_aplicar(uuid, text, jsonb), public.klingo_cancelamento_aplicar(uuid, text, text) from public, anon, authenticated;
grant execute on function public.klingo_marc_quando(date, text), public.klingo_marc_prazo_ok(date, text), public.klingo_marc_resumo(uuid, text), public.klingo_marcacoes_pedir(uuid),
  public.klingo_marcacoes_aplicar(uuid, text, jsonb), public.klingo_cancelamento_aplicar(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3b. klingo_operacao_concluir: caminhos novos (ler_vouchers, cancelar pela lista) e conferência do voucher antigo na remarcação
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.klingo_operacao_concluir(p_op uuid, p_estado text, p_r jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  op public.klingo_operacao; pa public.pre_agendamentos; v jsonb := coalesce(p_r -> 'voucher', '{}'::jsonb); v_est text := p_estado; ctx jsonb; v_txt text; v_dias text[] := array['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'];
  v_data date; v_cod text := left(p_r ->> 'codigo', 60); v_plano text; v_rem boolean;
begin
  if v_est not in ('sucesso', 'falha', 'incerto', 'horario_tomado') then v_est := 'falha'; end if;
  select * into op from public.klingo_operacao where id = p_op for update;
  if op.id is null then return jsonb_build_object('ok', false, 'motivo', 'inexistente'); end if;
  if op.estado in ('sucesso', 'cancelada') then return jsonb_build_object('ok', true, 'repetido', true); end if;
  select * into pa from public.pre_agendamentos where id = op.pre_agendamento_id;
  ctx := public.fluxo_ctx(op.conversa_id);
  update public.klingo_operacao set estado = v_est, voucher_id = left(v ->> 'id', 30), http_status = nullif(p_r ->> 'http_status', '')::int, caminho = left(p_r ->> 'caminho', 80), codigo = v_cod, concluido_em = now() where id = p_op;
  perform public.klingo_medir('op_' || v_est, 1, extract(milliseconds from now() - op.iniciado_em)::bigint);
  v_rem := op.tipo = 'remarcar';

  -- v2.1: ver minhas marcações (só leitura) e cancelamento pedido pela lista de marcações do Klingo
  if op.tipo = 'ler_vouchers' then return public.klingo_marcacoes_aplicar(op.id, v_est, p_r); end if;
  if op.tipo = 'cancelar' and coalesce(op.detalhe ->> 'origem', '') = 'marcacoes' then return public.klingo_cancelamento_aplicar(op.id, v_est, v_cod); end if;

  -- cancelar
  if op.tipo = 'cancelar' then
    if v_est = 'sucesso' then
      update public.pre_agendamentos set status = 'cancelado', conferencia_status = 'sumiu', atualizado_em = now() where id = pa.id;
      update public.conversa_fluxo set passo = 'cancelado', dados = dados || jsonb_build_object('cancelado_em', now()), atualizado_em = now() where conversa_id = op.conversa_id;
      perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('cancelado', ctx), jsonb_build_object('tipo', 'nova'));
      update public.conversas set status = 'encerrada', encerrada_em = now(), motivo_encerramento = 'desistiu', encerramento_origem = 'sistema' where id = op.conversa_id and status <> 'encerrada';
      return jsonb_build_object('ok', true, 'estado', 'sucesso');
    end if;
    perform public.fluxo_nota(op.conversa_id, 'Cancelamento automático NÃO concluído (' || coalesce(v_cod, 'falha') || '). O agendamento ' || coalesce(op.detalhe ->> 'voucher', '?') || ' pode continuar ativo no Klingo: conferir.');
    perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('cancelar_equipe', ctx));
    perform public.fluxo_transferir(op.conversa_id, 'Paciente pediu para cancelar o agendamento e o cancelamento automático não concluiu (' || coalesce(v_cod, 'falha') || ').', case when v_est = 'incerto' then 'media' else 'baixa' end, false);
    return jsonb_build_object('ok', true, 'estado', v_est);
  end if;

  if v_est = 'sucesso' and nullif(v ->> 'id', '') is not null then
    v_data := (v ->> 'data')::date;
    if v_rem then
      update public.pre_agendamentos set klingo_marcacoes = array[v ->> 'id'], conferencia_status = 'confirmado', conferencia_detalhe = null, conferencia_em = now(), etapa = 'pronto',
             status = 'agendado', agendado_origem = coalesce(agendado_origem, 'chat_api'), agendado_auto_em = coalesce(agendado_auto_em, now()), escolha_horario_chat = coalesce(escolha_horario_chat, escolha_horario),
             escolha_horario = jsonb_build_array(jsonb_build_object('grupo', 1, 'data', v ->> 'data', 'hora', v ->> 'hora', 'min', 30, 'chegada', false, 'unidade', nullif(v ->> 'unidade', ''),
                               'profissional', nullif(v ->> 'profissional', ''), 'procedimento', nullif(v ->> 'procedimento', ''), 'origem', 'klingo_api', 'klingo_chave', op.detalhe ->> 'chave')), atualizado_em = now()
       where id = pa.id;
      update public.conversa_fluxo set passo = 'marcado', dados = (dados - 'remarcando') || jsonb_build_object('marcado_em', now(), 'operacao', p_op), atualizado_em = now() where conversa_id = op.conversa_id;
    else
      update public.pre_agendamentos set status = 'agendado', agendado_origem = 'chat_api', agendado_auto_em = now(), klingo_marcacoes = array[v ->> 'id'], conferencia_status = 'confirmado', conferencia_detalhe = null,
             conferencia_em = now(), conferencia_falhas = 0, confirmacao_enviada_em = coalesce(confirmacao_enviada_em, now()), etapa = 'pronto',
             escolha_horario_chat = coalesce(escolha_horario_chat, escolha_horario),
             escolha_horario = jsonb_build_array(jsonb_build_object('grupo', 1, 'data', v ->> 'data', 'hora', v ->> 'hora', 'min', 30, 'chegada', false, 'unidade', nullif(v ->> 'unidade', ''),
                               'profissional', nullif(v ->> 'profissional', ''), 'procedimento', nullif(v ->> 'procedimento', ''), 'origem', 'klingo_api', 'klingo_chave', op.detalhe ->> 'chave')),
             atualizado_em = now()
       where id = pa.id;
      update public.conversa_fluxo set passo = 'marcado', dados = dados || jsonb_build_object('marcado_em', now(), 'operacao', p_op), atualizado_em = now() where conversa_id = op.conversa_id;
    end if;
    v_txt := public.fluxo_t(case when v_rem then 'remarcado' else 'marcado' end, ctx) || E'\n\n' || coalesce(nullif(v ->> 'procedimento', ''), 'Atendimento') || E'\n'
             || v_dias[extract(dow from v_data)::int + 1] || ', ' || to_char(v_data, 'DD/MM') || ' às ' || (v ->> 'hora')
             || coalesce(E'\n' || nullif(v ->> 'unidade', ''), '') || coalesce(E'\nCom ' || nullif(v ->> 'profissional', ''), '')
             || E'\n\nChegue com 15 minutos de antecedência, com documento com foto' || case when public.norm_nome(pa.plano) = 'PARTICULAR' then '.' else ' e a carteirinha do convênio.' end
             || E' Se precisar remarcar ou cancelar, é só tocar em um dos botões abaixo.';
    if v_rem then   -- v2.1: o que sobrou do agendamento antigo
      update public.pre_agendamentos set conferencia_status = 'remarcado', conferencia_detalhe = left('Remarcado pelo chat (conversa ' || op.conversa_id::text || ') em ' || to_char(now() at time zone 'America/Bahia', 'DD/MM HH24:MI'), 200), conferencia_em = now()
       where id <> pa.id and klingo_marcacoes @> array[op.detalhe ->> 'remarcacao'] and status = 'agendado';
      update public.klingo_marcacao set situacao = 'remarcada' where voucher = op.detalhe ->> 'remarcacao' and situacao = 'ativa';
      if p_r ->> 'antigo' = 'ativo' then
        perform public.fluxo_nota(op.conversa_id, 'ATENÇÃO: remarcação feita (voucher novo ' || (v ->> 'id') || '), mas o agendamento ANTIGO (voucher ' || coalesce(op.detalhe ->> 'remarcacao', '?') || ') continua ATIVO no Klingo: há DOIS agendamentos. Cancelar o antigo no Klingo e conferir com o paciente.');
        v_txt := v_txt || E'\n\nAtenção: o sistema ainda mostra o horário anterior como ativo. Já avisei a nossa equipe para cancelar o anterior e conferir tudo com você.';
      elsif p_r ->> 'antigo' = 'desconhecido' then
        perform public.fluxo_nota(op.conversa_id, 'Remarcação feita (voucher novo ' || (v ->> 'id') || '). Não foi possível conferir se o agendamento antigo (voucher ' || coalesce(op.detalhe ->> 'remarcacao', '?') || ') foi cancelado: conferir no Klingo.');
      end if;
    end if;
    perform public.fluxo_dizer(op.conversa_id, v_txt, jsonb_build_object('tipo', 'marcado', 'voucher', jsonb_build_object('id', v ->> 'id', 'data', v ->> 'data', 'hora', v ->> 'hora',
      'procedimento', v ->> 'procedimento', 'unidade', v ->> 'unidade', 'profissional', v ->> 'profissional')));
    perform public.fluxo_pos_menu(op.conversa_id);
    if v_rem and p_r ->> 'antigo' = 'ativo' then perform public.fluxo_transferir(op.conversa_id, 'Remarcação concluída, mas o agendamento antigo (voucher ' || coalesce(op.detalhe ->> 'remarcacao', '?') || ') continua ativo no Klingo: cancelar o antigo.', 'alta', false); end if;
    return jsonb_build_object('ok', true, 'estado', 'sucesso');
  end if;

  if v_est = 'horario_tomado' then
    delete from public.klingo_oferta where conversa_id = op.conversa_id and chave = op.detalhe ->> 'chave';
    update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null, atualizado_em = now() where id = pa.id and status not in ('cancelado') and (status <> 'agendado' or v_rem);
    update public.conversa_fluxo set dados = dados || '{"confirmado": false, "sem_horario": false}'::jsonb, atualizado_em = now() where conversa_id = op.conversa_id;
    perform public.fluxo_perguntar(op.conversa_id, 'horario', public.fluxo_t('marcar_ocupado', ctx));
    return jsonb_build_object('ok', true, 'estado', 'horario_tomado');
  end if;

  -- remarcação que não concluiu: a equipe assume, o agendamento anterior segue valendo
  if v_rem then
    if v_est = 'incerto' and p_r ->> 'antigo' = 'cancelado' then
      perform public.fluxo_nota(op.conversa_id, 'URGENTE: a remarcação ficou INCERTA e o agendamento ANTIGO (voucher ' || coalesce(op.detalhe ->> 'remarcacao', '?') || ') já NÃO aparece ativo, e o novo não foi confirmado: o paciente pode estar SEM agendamento. Conferir na agenda do Klingo agora, antes de marcar de novo.');
    end if;
    perform public.fluxo_nota(op.conversa_id, 'Remarcação automática NÃO concluída (' || coalesce(v_cod, 'falha') || '). ' || case when v_est = 'incerto' then 'ATENÇÃO: o Klingo não confirmou; conferir na agenda se o horário novo foi marcado ANTES de repetir. ' else '' end
      || 'O agendamento anterior (voucher ' || coalesce(op.detalhe ->> 'remarcacao', '?') || ') pode continuar ativo.');
    perform public.fluxo_dizer(op.conversa_id, public.fluxo_t(case when v_est = 'incerto' then 'marcar_incerto' else 'marcar_equipe' end, ctx));
    perform public.fluxo_transferir(op.conversa_id, 'Paciente quer remarcar o agendamento e a remarcação automática não concluiu (' || coalesce(v_cod, 'falha') || ').', case when v_est = 'incerto' and p_r ->> 'antigo' = 'cancelado' then 'alta' when v_est = 'incerto' then 'media' else 'baixa' end, false);
    update public.conversa_fluxo set dados = dados - 'remarcando', atualizado_em = now() where conversa_id = op.conversa_id;
    return jsonb_build_object('ok', true, 'estado', v_est);
  end if;

  v_plano := coalesce(pa.plano, '');
  if v_est = 'incerto' then
    perform public.fluxo_finalizar_humano(op.conversa_id, 'ATENÇÃO: a marcação automática ficou INCERTA (o Klingo não confirmou). Conferir na agenda do Klingo se o horário ' || to_char(coalesce((op.detalhe ->> 'data')::date, current_date), 'DD/MM') || ' ' || coalesce(op.detalhe ->> 'hora', '?') || ' foi marcado ANTES de marcar de novo. Código: ' || coalesce(v_cod, '?'), 'media', 'marcar_incerto');
  elsif v_cod like 'divergencia_2:%' then
    perform public.fluxo_nota(op.conversa_id, 'Cadastro com 2 ou mais campos diferentes do Klingo (' || substr(v_cod, 15) || '). Nada foi marcado. O paciente foi orientado a comparecer à CSI com documento com foto para marcar e atualizar o cadastro.');
    perform public.fluxo_dizer(op.conversa_id, public.fluxo_t('divergencia_clinica', ctx));
    perform public.fluxo_transferir(op.conversa_id, 'Cadastro do paciente diverge do Klingo em mais de um campo (' || substr(v_cod, 15) || '). Paciente orientado a vir à clínica.', 'baixa', false);
  elsif v_cod like 'divergencia_1:%' then
    perform public.fluxo_finalizar_humano(op.conversa_id, 'Um campo do cadastro diverge do Klingo (' || substr(v_cod, 15) || '). Validar com o paciente: corrigir no Klingo se estiver certo no chat, ou pedir que atualize quando vier à clínica. Nada foi marcado.', 'baixa', 'marcar_equipe');
  elsif v_cod in ('plano_inativo', 'plano_desconhecido', 'sem_medico') then
    perform public.fluxo_finalizar_humano(op.conversa_id, 'Marcação automática não feita: convênio ' || v_plano || ' não aceito para este horário (' || v_cod || '). Resolver o convênio com o paciente.', 'baixa', 'marcar_plano');
  else
    perform public.fluxo_finalizar_humano(op.conversa_id, 'Marcação automática não feita (' || coalesce(v_cod, 'falha') || '). A equipe confirma o horário com o paciente.', 'baixa', 'marcar_equipe');
  end if;
  return jsonb_build_object('ok', true, 'estado', v_est);
end $function$;;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 4. Fluxo do chat: próximo passo, perguntas e respostas de "Ver / Cancelar / Remarcar" e de "Resultado de exame"
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.fluxo_marc_ativo(p_conversa uuid, d jsonb) returns boolean
  language sql stable security definer set search_path to ''
as $f$
  select d ->> 'assunto' in ('Remarcar', 'Cancelar', 'Minhas marcações') and coalesce(d ->> 'marc_estado', '') not in ('', 'local') and public.klingo_ativo(p_conversa, 'klingo_api_consultar')
$f$;

create or replace function public.fluxo_marc_proximo(p_conversa uuid, d jsonb) returns text
  language plpgsql stable security definer set search_path to ''
as $f$
begin
  case d ->> 'marc_estado'
    when 'consultando' then return 'marc_consultando';
    when 'vazio' then return 'marc_vazio';
    when 'pos' then return 'marc_pos';
    when 'pronto' then
      if d ->> 'marc_acao' = 'cancelando' then return 'marc_consultando'; end if;
      if d ->> 'marc_voucher' is null then return 'marc_lista'; end if;
      if d ->> 'marc_acao' = 'cancelar' then return 'marc_cancelar'; end if;
      return 'marc_acao';
    else return 'assunto_texto';
  end case;
end $f$;

-- Assunto: caminho único (substitui a versão antiga, que não era mais chamada). Sem a chave de consulta ligada, tudo segue como antes: texto livre para a equipe.
create or replace function public.fluxo_proximo_assunto(p_conversa uuid, d jsonb) returns text
  language plpgsql stable security definer set search_path to ''
as $f$
begin
  if d ->> 'assunto' is null then return 'assunto'; end if;
  if coalesce((d ->> 'assunto_resolvido')::boolean, false) then return 'assunto_fim'; end if;
  if d ->> 'assunto' = 'Resultado de exame' and not coalesce((d ->> 'resultado_feito')::boolean, false) then
    if d ->> 'resultado_situacao' is null then return 'resultado_situacao'; end if;
    if d ->> 'resultado_estado' = 'consultando' then return 'marc_consultando'; end if;
    return 'resultado_orientacao';
  end if;
  if public.fluxo_marc_ativo(p_conversa, d) then return public.fluxo_marc_proximo(p_conversa, d); end if;
  return 'assunto_texto';
end $f$;

create or replace function public.fluxo_marc_iniciar(p_conversa uuid, p_assunto text) returns void
  language plpgsql security definer set search_path to ''
as $f$
declare v_op uuid;
begin
  perform public.fluxo_set(p_conversa, '{"marc_estado": null, "marc_op": null, "marc_voucher": null, "marc_acao": null, "resultado_situacao": null, "resultado_feito": null, "resultado_estado": null, "resultado_op": null, "assunto_resolvido": null}'::jsonb);
  if p_assunto in ('Remarcar', 'Cancelar', 'Minhas marcações') then
    v_op := public.klingo_marcacoes_pedir(p_conversa);
    if v_op is null then perform public.fluxo_set(p_conversa, '{"marc_estado": "local"}'::jsonb); end if;   -- chave desligada ou sem CPF/nascimento: segue o caminho antigo (texto para a equipe)
  end if;
end $f$;

create or replace function public.fluxo_marc_pergunta(p_conversa uuid, p_passo text) returns jsonb
  language plpgsql stable security definer set search_path to ''
as $f$
declare
  d jsonb; ctx jsonb := public.fluxo_ctx(p_conversa); v_it jsonb := '[]'::jsonb; v_hoje date := (now() at time zone 'America/Bahia')::date; m record; v_sit text; v_txt text;
begin
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  case p_passo
  when 'marc_consultando' then
    if d ->> 'resultado_estado' = 'consultando' then
      return jsonb_build_object('texto', public.fluxo_t('resultado_consultando', ctx), 'op', jsonb_build_object('tipo', 'marcando', 'operacao', d ->> 'resultado_op', 'titulo', 'Conferindo o seu resultado…'));
    end if;
    return jsonb_build_object('texto', public.fluxo_t(case when d ->> 'marc_acao' = 'cancelando' then 'marc_cancelando' else 'marc_consultando' end, ctx),
      'op', jsonb_build_object('tipo', 'marcando', 'operacao', d ->> 'marc_op', 'titulo', case when d ->> 'marc_acao' = 'cancelando' then 'Cancelando…' else 'Consultando as suas marcações…' end));
  when 'marc_lista' then
    for m in select * from public.klingo_marcacao where conversa_id = p_conversa and situacao = 'ativa' and data >= v_hoje order by data, hora limit 8 loop
      v_it := v_it || jsonb_build_object('valor', 'm:' || m.voucher, 'rotulo', coalesce(nullif(m.procedimento, ''), 'Atendimento') || ' — ' || public.klingo_marc_quando(m.data, m.hora));
    end loop;
    v_it := v_it || jsonb_build_object('valor', 'nenhum', 'rotulo', 'Não é nenhuma destas');
    return jsonb_build_object('texto', public.fluxo_t('marc_lista', ctx), 'op', public.fluxo_escolha(p_passo, v_it));
  when 'marc_acao' then
    v_txt := public.klingo_marc_resumo(p_conversa, d ->> 'marc_voucher');
    return jsonb_build_object('texto', coalesce(v_txt || E'\n\n', '') || public.fluxo_t('marc_acao', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'cancelar', 'rotulo', 'Cancelar esta marcação'), jsonb_build_object('valor', 'remarcar', 'rotulo', 'Remarcar para outro horário'),
      jsonb_build_object('valor', 'outra', 'rotulo', 'Ver outra marcação'), jsonb_build_object('valor', 'equipe', 'rotulo', 'Falar com a equipe'),
      jsonb_build_object('valor', 'fim', 'rotulo', 'Está tudo certo, obrigado'))));
  when 'marc_cancelar' then
    return jsonb_build_object('texto', coalesce(public.klingo_marc_resumo(p_conversa, d ->> 'marc_voucher') || E'\n\n', '') || public.fluxo_t('marc_cancelar', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'cancelar_sim', 'rotulo', 'Sim, cancelar'), jsonb_build_object('valor', 'cancelar_nao', 'rotulo', 'Não, manter a marcação'))));
  when 'marc_vazio' then
    return jsonb_build_object('texto', public.fluxo_t('marc_vazio', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'nova', 'rotulo', 'Fazer uma nova marcação'), jsonb_build_object('valor', 'equipe', 'rotulo', 'Falar com a equipe'), jsonb_build_object('valor', 'fim', 'rotulo', 'Está tudo certo, obrigado'))));
  when 'marc_pos' then
    return jsonb_build_object('texto', public.fluxo_t('marc_pos', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'ver', 'rotulo', 'Ver minhas marcações'), jsonb_build_object('valor', 'nova', 'rotulo', 'Fazer uma nova marcação'), jsonb_build_object('valor', 'fim', 'rotulo', 'Está tudo certo, obrigado'))));
  when 'resultado_situacao' then
    return jsonb_build_object('texto', public.fluxo_t('resultado_situacao', ctx), 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'pronto', 'rotulo', 'Saber se o meu resultado já está pronto'), jsonb_build_object('valor', 'acesso', 'rotulo', 'Receber o link ou a senha do resultado'),
      jsonb_build_object('valor', 'problema', 'rotulo', 'O resultado tem algum problema'), jsonb_build_object('valor', 'equipe', 'rotulo', 'Falar com a equipe'))));
  when 'resultado_orientacao' then
    v_sit := coalesce(d ->> 'resultado_situacao', 'pronto');
    v_txt := coalesce((select nullif(btrim(texto), '') from public.fluxo_texto where chave = 'resultado_orientacao_' || v_sit), (select nullif(btrim(texto), '') from public.fluxo_texto where chave = 'resultado_orientacao'));
    return jsonb_build_object('texto', v_txt, 'op', public.fluxo_escolha(p_passo, jsonb_build_array(
      jsonb_build_object('valor', 'equipe', 'rotulo', 'Chamar a equipe agora'), jsonb_build_object('valor', 'resolvido', 'rotulo', 'Era só isso, obrigado'))));
  else
    return jsonb_build_object('texto', public.fluxo_t('assunto_fim', ctx), 'op', jsonb_build_object('tipo', 'nova'));
  end case;
end $f$;

create or replace function public.fluxo_marc_aplicar(p_conversa uuid, p_passo text, v text) returns jsonb
  language plpgsql security definer set search_path to ''
as $f$
declare
  d jsonb; ctx jsonb := public.fluxo_ctx(p_conversa); m public.klingo_marcacao; pa public.pre_agendamentos; v_vou text; v_orig uuid; v_op uuid; v_h integer := coalesce(nullif(public.klingo_cfg('klingo_pos_prazo_horas', '24'), '')::integer, 24);
  v_valida integer := coalesce(nullif(public.klingo_cfg('klingo_marc_validade_min', '30'), '')::integer, 30); v_ctxt text; v_tipo text; v_sit text; v_n integer;
begin
  select coalesce(dados, '{}'::jsonb) into d from public.conversa_fluxo where conversa_id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  v_vou := d ->> 'marc_voucher';
  select * into m from public.klingo_marcacao where conversa_id = p_conversa and voucher = v_vou and situacao = 'ativa';

  case p_passo
  when 'marc_lista' then
    if v = 'nenhum' then
      perform public.fluxo_set(p_conversa, '{"marc_estado": "pos", "marc_voucher": null}'::jsonb);
      return '{"ok": true}'::jsonb;
    end if;
    if v is null or v !~ '^m:[0-9]{1,12}$' then return '{"ok": false}'::jsonb; end if;
    select * into m from public.klingo_marcacao where conversa_id = p_conversa and voucher = substr(v, 3) and situacao = 'ativa' and consultado_em > now() - make_interval(mins => v_valida);
    if m.id is null then   -- lista velha ou marcação que não é deste cadastro: consulta de novo, nunca confia
      perform public.klingo_marcacoes_pedir(p_conversa);
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('marc_desatualizada', ctx));
    end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('marc_voucher', m.voucher, 'marc_acao', null));
    return '{"ok": true}'::jsonb;

  when 'marc_acao' then
    if m.id is null then perform public.klingo_marcacoes_pedir(p_conversa); return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('marc_desatualizada', ctx)); end if;
    v_ctxt := 'marcação ' || m.voucher || ' (' || coalesce(m.procedimento, 'atendimento') || ', ' || public.klingo_marc_quando(m.data, m.hora) || ')';
    case v
    when 'outra' then
      perform public.fluxo_set(p_conversa, '{"marc_voucher": null, "marc_acao": null}'::jsonb); return '{"ok": true}'::jsonb;
    when 'fim' then
      perform public.fluxo_set(p_conversa, '{"assunto_resolvido": true}'::jsonb); return '{"ok": true}'::jsonb;
    when 'equipe' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', left('Paciente quer falar com a equipe sobre a ' || v_ctxt, 500)));
      return '{"ok": true, "transferir": true}'::jsonb;
    when 'cancelar', 'remarcar' then
      if not public.klingo_ativo(p_conversa, case when v = 'cancelar' then 'klingo_api_cancelar' else 'klingo_api_remarcar' end) then
        perform public.fluxo_dizer(p_conversa, public.fluxo_t('marc_desligado', ctx));
        perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', left('Paciente quer ' || v || ' a ' || v_ctxt || ' (automático desligado).', 500)));
        return '{"ok": true, "transferir": true}'::jsonb;
      end if;
      if not public.klingo_marc_prazo_ok(m.data, m.hora) then
        perform public.fluxo_dizer(p_conversa, public.fluxo_t('marc_prazo', ctx || jsonb_build_object('horas', v_h::text)));
        perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', left('Paciente quer ' || v || ' a ' || v_ctxt || ' com menos de ' || v_h || ' h de antecedência.', 500)));
        return '{"ok": true, "transferir": true}'::jsonb;
      end if;
      if v = 'cancelar' then
        perform public.fluxo_set(p_conversa, '{"marc_acao": "cancelar"}'::jsonb); return '{"ok": true}'::jsonb;
      end if;
      -- REMARCAR: só quando sabemos o serviço e o convênio da marcação (o pedido que a originou está no nosso banco, do mesmo CPF)
      v_orig := null;
      if pa.klingo_marcacoes @> array[m.voucher] and pa.status = 'agendado' then v_orig := p_conversa;
      else
        select x.conversa_id into v_orig from public.pre_agendamentos x
         where x.klingo_marcacoes @> array[m.voucher] and x.status = 'agendado' and x.conversa_id <> p_conversa
           and regexp_replace(coalesce(x.paciente ->> 'cpf', ''), '\D', '', 'g') = regexp_replace(coalesce(pa.paciente ->> 'cpf', ''), '\D', '', 'g') and coalesce(pa.paciente ->> 'cpf', '') <> ''
         order by x.atualizado_em desc limit 1;
      end if;
      if v_orig is null or (v_orig <> p_conversa and not public.agendamento_preparar_remarcacao(p_conversa, v_orig)) then
        perform public.fluxo_dizer(p_conversa, public.fluxo_t('marc_remarcar_equipe', ctx));
        perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', left('Paciente quer REMARCAR a ' || v_ctxt || '. Remarcação automática indisponível (marcação feita fora do chat ou sem o pedido original). O horário atual NÃO foi alterado.', 500)));
        return '{"ok": true, "transferir": true}'::jsonb;
      end if;
      select tipo into v_tipo from public.pre_agendamentos where conversa_id = coalesce(nullif(v_orig, p_conversa), p_conversa);
      delete from public.klingo_oferta where conversa_id = p_conversa;
      update public.pre_agendamentos set escolha_horario = null, data_desejada = null, hora_desejada = null, atualizado_em = now() where conversa_id = p_conversa;
      -- o horário atual continua valendo até o novo ser confirmado: guardamos qual é e voltamos à escolha do horário (o executor manda o voucher antigo em "remarcacao")
      perform public.fluxo_set(p_conversa, jsonb_build_object('assunto', null, 'motivo', coalesce(v_tipo, 'exame'), 'remarcando', jsonb_build_object('voucher', m.voucher, 'data', m.data, 'hora', m.hora, 'procedimento', m.procedimento),
        'confirmado', false, 'sem_horario', false, 'medico_feito', true, 'atalho_feito', true, 'marc_estado', null, 'marc_voucher', null, 'marc_acao', null));
      return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('marc_remarcar_inicio', ctx));
    else return '{"ok": false}'::jsonb;
    end case;

  when 'marc_cancelar' then
    if v = 'cancelar_nao' then perform public.fluxo_set(p_conversa, '{"marc_acao": null}'::jsonb); return '{"ok": true}'::jsonb; end if;
    if v <> 'cancelar_sim' then return '{"ok": false}'::jsonb; end if;
    -- tudo conferido de novo na hora de confirmar: marcação desta lista e recente, chave ligada, prazo, e só UMA operação por vez
    if m.id is null or m.consultado_em < now() - make_interval(mins => v_valida) then
      perform public.klingo_marcacoes_pedir(p_conversa); return jsonb_build_object('ok', true, 'aviso', public.fluxo_t('marc_desatualizada', ctx));
    end if;
    if not public.klingo_ativo(p_conversa, 'klingo_api_cancelar') or not public.klingo_marc_prazo_ok(m.data, m.hora) then
      perform public.fluxo_dizer(p_conversa, public.fluxo_t('marc_prazo', ctx || jsonb_build_object('horas', v_h::text)));
      perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', left('Paciente quer CANCELAR a marcação ' || m.voucher || ' (' || public.klingo_marc_quando(m.data, m.hora) || ') e o automático não se aplica.', 500)));
      return '{"ok": true, "transferir": true}'::jsonb;
    end if;
    select id into v_op from public.klingo_operacao where conversa_id = p_conversa and tipo = 'cancelar' and detalhe ->> 'voucher' = m.voucher and estado in ('pendente', 'executando', 'incerto') order by criado_em desc limit 1;
    if v_op is null then
      select count(*) into v_n from public.klingo_operacao where conversa_id = p_conversa and tipo = 'cancelar' and detalhe ->> 'voucher' = m.voucher;
      insert into public.klingo_operacao (conversa_id, pre_agendamento_id, tipo, chave_idem, detalhe)
      values (p_conversa, pa.id, 'cancelar', 'cancelar_marc:' || p_conversa::text || ':' || m.voucher || ':' || v_n::text, jsonb_build_object('voucher', m.voucher, 'origem', 'marcacoes'))
      on conflict (chave_idem) do nothing returning id into v_op;
      if v_op is not null then
        perform public.klingo_operacao_disparar(v_op); perform public.klingo_medir('op_criada');
      else
        select id into v_op from public.klingo_operacao where chave_idem = 'cancelar_marc:' || p_conversa::text || ':' || m.voucher || ':' || v_n::text;
      end if;
    end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('marc_acao', 'cancelando', 'marc_op', v_op));
    return '{"ok": true}'::jsonb;

  when 'marc_vazio', 'marc_pos' then
    case v
    when 'nova' then perform public.fluxo_set(p_conversa, '{"assunto": null, "motivo": null, "marc_estado": null, "marc_voucher": null, "marc_acao": null}'::jsonb); return '{"ok": true}'::jsonb;
    when 'ver' then if p_passo = 'marc_pos' then perform public.klingo_marcacoes_pedir(p_conversa); return '{"ok": true}'::jsonb; end if; return '{"ok": false}'::jsonb;
    when 'equipe' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('assunto_texto', 'Paciente quer falar com a equipe sobre as marcações.'));
      return '{"ok": true, "transferir": true}'::jsonb;
    when 'fim' then perform public.fluxo_set(p_conversa, '{"assunto_resolvido": true}'::jsonb); return '{"ok": true}'::jsonb;
    else return '{"ok": false}'::jsonb;
    end case;

  when 'marc_consultando' then
    return '{"ok": true}'::jsonb;   -- toque durante a espera: nada a fazer (a resposta chega sozinha)

  when 'resultado_situacao' then
    if v = 'equipe' then
      perform public.fluxo_set(p_conversa, jsonb_build_object('resultado_feito', true, 'assunto_texto', 'Resultado de exame: o paciente pediu para falar com a equipe.'));
      return '{"ok": true, "transferir": true}'::jsonb;
    end if;
    if v not in ('pronto', 'acesso', 'problema') then return '{"ok": false}'::jsonb; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('resultado_situacao', v));
    if v = 'pronto' then perform public.klingo_resultados_pedir(p_conversa); end if;   -- só se klingo_api_resultado estiver ligada; senão segue só a orientação
    return '{"ok": true}'::jsonb;

  when 'resultado_orientacao' then
    v_sit := coalesce(d ->> 'resultado_situacao', 'pronto');
    if v = 'resolvido' then perform public.fluxo_set(p_conversa, '{"assunto_resolvido": true}'::jsonb); return '{"ok": true}'::jsonb; end if;
    if v <> 'equipe' then return '{"ok": false}'::jsonb; end if;
    perform public.fluxo_set(p_conversa, jsonb_build_object('resultado_feito', true, 'assunto_texto', left('Resultado de exame (' || case v_sit when 'pronto' then 'saber se está pronto' when 'acesso' then 'link ou senha de acesso' else 'problema com o resultado' end || '): o paciente pediu a equipe.', 500)));
    return '{"ok": true, "transferir": true}'::jsonb;
  else
    return '{"ok": false}'::jsonb;
  end case;
end $f$;

revoke all on function public.fluxo_marc_ativo(uuid, jsonb), public.fluxo_marc_proximo(uuid, jsonb), public.fluxo_proximo_assunto(uuid, jsonb), public.fluxo_marc_iniciar(uuid, text),
  public.fluxo_marc_pergunta(uuid, text), public.fluxo_marc_aplicar(uuid, text, text) from public, anon, authenticated;
grant execute on function public.fluxo_marc_ativo(uuid, jsonb), public.fluxo_marc_proximo(uuid, jsonb), public.fluxo_proximo_assunto(uuid, jsonb), public.fluxo_marc_iniciar(uuid, text),
  public.fluxo_marc_pergunta(uuid, text), public.fluxo_marc_aplicar(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 5. Encaixe no motor existente (cada trecho tem de existir EXATAMENTE uma vez; senão a migração para sem mudar nada)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function pg_temp.encaixar(p_assinatura text, p_antigo text, p_novo text) returns void language plpgsql as $f$
declare d text := pg_get_functiondef(p_assinatura::regprocedure); n integer;
begin
  if position(p_novo in d) > 0 then return; end if;   -- já encaixado (reaplicar a migração é seguro)
  n := (length(d) - length(replace(d, p_antigo, ''))) / length(p_antigo);
  if n <> 1 then raise exception '%: trecho esperado achado % vez(es) (esperado 1): %', p_assinatura, n, left(p_antigo, 70); end if;
  execute replace(d, p_antigo, p_novo);
end $f$;

-- (a) o motor pergunta os passos novos
select pg_temp.encaixar('public.fluxo_perguntar(uuid, text, text)',
  E'  when ''assunto_qual'', ''assunto_confirma'', ''assunto_resultado'', ''assunto_fim'' then',
  E'  when ''marc_consultando'', ''marc_lista'', ''marc_acao'', ''marc_cancelar'', ''marc_vazio'', ''marc_pos'', ''resultado_situacao'', ''resultado_orientacao'' then   -- v2.1: pós-agendamento e resultado\n    v_op := public.fluxo_marc_pergunta(p_conversa, p_passo);\n    v_txt := v_op ->> ''texto'';\n    v_op := v_op -> ''op'';\n  when ''assunto_qual'', ''assunto_confirma'', ''assunto_resultado'', ''assunto_fim'' then');
select pg_temp.encaixar('public.fluxo_perguntar(uuid, text, text)',
  E'    v_op := public.fluxo_escolha(p_passo, jsonb_build_array(\n      jsonb_build_object(''valor'', ''Remarcar'', ''rotulo'', ''Remarcar um horário''),',
  E'    v_op := public.fluxo_escolha(p_passo, (case when public.klingo_ativo(p_conversa, ''klingo_api_consultar'') then jsonb_build_array(jsonb_build_object(''valor'', ''Minhas marcações'', ''rotulo'', ''Ver minhas marcações'')) else ''[]''::jsonb end) || jsonb_build_array(\n      jsonb_build_object(''valor'', ''Remarcar'', ''rotulo'', ''Remarcar um horário''),');
-- (b) o motor aplica as respostas e começa a consulta quando o paciente escolhe o assunto
select pg_temp.encaixar('public.fluxo_aplicar(uuid, text, jsonb)',
  E'  when ''assunto_qual'', ''assunto_confirma'', ''assunto_resultado'' then',
  E'  when ''marc_consultando'', ''marc_lista'', ''marc_acao'', ''marc_cancelar'', ''marc_vazio'', ''marc_pos'', ''resultado_situacao'', ''resultado_orientacao'' then   -- v2.1\n    return public.fluxo_marc_aplicar(p_conversa, p_passo, v);\n  when ''assunto_qual'', ''assunto_confirma'', ''assunto_resultado'' then');
select pg_temp.encaixar('public.fluxo_aplicar(uuid, text, jsonb)',
  E'    perform public.fluxo_set(p_conversa, jsonb_build_object(''assunto'', left(v, 60)));',
  E'    perform public.fluxo_set(p_conversa, jsonb_build_object(''assunto'', left(v, 60)));\n    perform public.fluxo_marc_iniciar(p_conversa, left(v, 60));   -- v2.1: ver, cancelar e remarcar consultam o Klingo');
-- (c) depois do assunto escolhido, o próximo passo vem do fluxo de assunto (que sem a chave ligada devolve "assunto_texto", como hoje)
select pg_temp.encaixar('public.fluxo_proximo(uuid)',
  E'return case when d ->> ''assunto'' is null then ''assunto'' else ''assunto_texto'' end;',
  E'return public.fluxo_proximo_assunto(p_conversa, d);   -- v2.1');
-- (d) texto livre enquanto espera; "voltar" não vale no meio da consulta ou do cancelamento
select pg_temp.encaixar('public.fluxo_avancar(uuid, jsonb)', E'if v_passo = ''marcando'' then', E'if v_passo in (''marcando'', ''marc_consultando'') then');
select pg_temp.encaixar('public.chat_voltar(uuid, text)', E'if v_passo in (''marcando'', ''marcado'', ''pos_menu'', ''pos_cancelar'', ''cancelado'') or exists',
  E'if v_passo in (''marcando'', ''marcado'', ''pos_menu'', ''pos_cancelar'', ''cancelado'', ''marc_consultando'', ''marc_lista'', ''marc_acao'', ''marc_cancelar'', ''marc_vazio'', ''marc_pos'') or exists');
-- (e) o que o paciente escreve (em vez de tocar no botão)
select pg_temp.encaixar('public.fluxo_ler_texto(uuid, text, text)',
  E'  when ''assunto_confirma'' then\n    if sim then return ''"sim"''; end if;',
  E'  when ''marc_acao'', ''marc_cancelar'', ''marc_vazio'', ''marc_pos'' then   -- v2.1\n    if p_passo = ''marc_cancelar'' then\n      if sim then return ''"cancelar_sim"''; end if;\n      if nao then return ''"cancelar_nao"''; end if;\n    end if;\n    if p_passo = ''marc_acao'' and t ~ ''(cancel|desmarc)'' then return ''"cancelar"''; end if;\n    if p_passo = ''marc_acao'' and t ~ ''(remarc|outro dia|outra data|mudar)'' then return ''"remarcar"''; end if;\n    if p_passo = ''marc_acao'' and t ~ ''(outra marcacao|outro agendamento|ver outra)'' then return ''"outra"''; end if;\n    if t ~ ''(atendente|pessoa|humano|equipe)'' then return ''"equipe"''; end if;\n    if p_passo in (''marc_vazio'', ''marc_pos'') and t ~ ''(nova marcacao|marcar|agendar|novo)'' then return ''"nova"''; end if;\n    if p_passo = ''marc_pos'' and t ~ ''(ver|consultar|minhas)'' then return ''"ver"''; end if;\n    if p_passo <> ''marc_cancelar'' and t ~ ''(obrigad|tudo certo|era so isso|so isso)'' then return ''"fim"''; end if;\n  when ''resultado_situacao'' then\n    if t ~ ''(pronto|saiu|liberad)'' then return ''"pronto"''; end if;\n    if t ~ ''(link|senha|acesso|site)'' then return ''"acesso"''; end if;\n    if t ~ ''(problema|erro|errado|trocado)'' then return ''"problema"''; end if;\n    if t ~ ''(atendente|pessoa|humano|equipe)'' then return ''"equipe"''; end if;\n  when ''resultado_orientacao'' then\n    if t ~ ''(atendente|pessoa|humano|equipe)'' or nao then return ''"equipe"''; end if;\n    if sim or t ~ ''(obrigad|resolv|valeu)'' then return ''"resolvido"''; end if;\n  when ''assunto_confirma'' then\n    if sim then return ''"sim"''; end if;');
select pg_temp.encaixar('public.fluxo_ler_texto(uuid, text, text)',
  E'    if t ~ ''(remarc|mudar (o )?(dia|horario))'' then return ''"Remarcar"''; end if;',
  E'    if t ~ ''(minha marcacao|minhas marcacoes|meu agendamento|meus agendamentos|ver (a |as )?(minha|minhas|meu|meus))'' then return ''"Minhas marcações"''; end if;   -- v2.1\n    if t ~ ''(remarc|mudar (o )?(dia|horario))'' then return ''"Remarcar"''; end if;');
select pg_temp.encaixar('public.fluxo_ler_texto(uuid, text, text)',
  E'(remarc|cancel|desmarc|resultado|laudo|duvida|reclama)',
  E'(remarc|cancel|desmarc|resultado|laudo|duvida|reclama|minha marcacao|minhas marcacoes|meu agendamento|meus agendamentos)');
-- (f) remarcar uma marcação que veio da lista do Klingo (conversa nova do mesmo paciente): vale quando o voucher está no retrato recente desta conversa; o executor ainda confere que ele está entre as marcações ATIVAS da sessão
select pg_temp.encaixar('public.klingo_pode_marcar(uuid)',
  E'pa.agendado_origem is distinct from ''chat_api'' or',
  E'(pa.agendado_origem is distinct from ''chat_api'' and not exists (select 1 from public.klingo_marcacao km where km.conversa_id = p_conversa and km.situacao = ''ativa'' and km.consultado_em > now() - interval ''6 hours'' and km.voucher = (select f2.dados -> ''remarcando'' ->> ''voucher'' from public.conversa_fluxo f2 where f2.conversa_id = p_conversa))) or');
-- (g) resposta incerta: ANTES de qualquer nova marcação ou remarcação do mesmo pedido, a equipe confere no Klingo. A criação devolve a operação incerta (nunca abre outra, mesmo que o contexto de remarcação já tenha sido limpo)
select pg_temp.encaixar('public.klingo_operacao_criar(uuid)',
  E'  v_tipo := case when jsonb_typeof(v_rem) = ''object'' then ''remarcar'' else ''marcar'' end;',
  E'  v_tipo := case when jsonb_typeof(v_rem) = ''object'' then ''remarcar'' else ''marcar'' end;\n  select id into v_op from public.klingo_operacao where pre_agendamento_id = pa.id and tipo in (''marcar'', ''remarcar'') and estado = ''incerto'' order by criado_em desc limit 1;   -- v2.1\n  if v_op is not null then return v_op; end if;');
-- (h) painel: números do pós-agendamento (só contagens; nenhum dado de paciente)
select pg_temp.encaixar('public.painel_automacao_resumo(date, date)',
  E'    \'cadastros\', (select coalesce(jsonb_object_agg(situacao, n)',
  E'    \'pos\', (select coalesce(jsonb_object_agg(k, n), \'{}\'::jsonb) from (select tipo || \':\' || estado k, count(*) n from public.klingo_operacao where tipo in (\'cancelar\', \'remarcar\', \'ler_vouchers\') and (criado_em at time zone \'America/Sao_Paulo\')::date between v_de and v_ate group by 1) x),\n    \'cadastros\', (select coalesce(jsonb_object_agg(situacao, n)');
-- (i) paciente preso em pergunta que não entende: depois de N respostas não compreendidas no MESMO passo (padrão 3), a conversa vai para a equipe com o contexto (nada se perde: o resumo e as notas seguem)
insert into public.fluxo_texto (chave, texto, descricao) values
  ('nao_entendi_equipe', 'Desculpe, não consegui entender. Vou chamar uma pessoa da nossa equipe para continuar com você, já com tudo o que conversamos até aqui.', 'Depois de várias respostas não compreendidas')
on conflict (chave) do nothing;
select pg_temp.encaixar('public.fluxo_avancar(uuid, jsonb)',
  E'        update public.conversa_fluxo set tentativas = tentativas + 1 where conversa_id = p_conversa;',
  E'        update public.conversa_fluxo set tentativas = tentativas + 1 where conversa_id = p_conversa;\n        if (select tentativas from public.conversa_fluxo where conversa_id = p_conversa) >= coalesce(nullif(public.klingo_cfg(\'fluxo_max_nao_entendi\', \'3\'), \'\')::integer, 3) then   -- v2.1: não deixa o paciente preso\n          perform public.fluxo_dizer(p_conversa, public.fluxo_t(\'nao_entendi_equipe\', ctx), jsonb_build_object(\'tipo\', \'acompanhar\'));\n          perform public.fluxo_transferir(p_conversa, \'Paciente não conseguiu responder à pergunta (passo \' || coalesce(v_passo, \'-\') || \') depois de várias tentativas.\', \'baixa\', true);\n          insert into public.fluxo_evento (conversa_id, passo, entrada, entendido, ms, ms_cliente) values (p_conversa, v_passo, \'nao_entendido_repetido\', false, extract(milliseconds from clock_timestamp() - v_t0), (p_entrada ->> \'ms\')::int);\n          return;\n        end if;');
-- (j) aviso do Klingo (webhook, ainda desligado): a lista de marcações acompanha cancelamento e remarcação avisados pelo Klingo
select pg_temp.encaixar('public.klingo_evento_aplicar(jsonb)',
  E'  select * into pa from public.pre_agendamentos where klingo_marcacoes @> array[v_id] limit 1;',
  E'  if v_nova ~ \'^[0-9]+$\' then update public.klingo_marcacao set situacao = \'remarcada\' where voucher = v_id and situacao = \'ativa\';   -- v2.1\n  elsif v_st = \'C\' then update public.klingo_marcacao set situacao = \'cancelada\' where voucher = v_id and situacao = \'ativa\'; end if;\n  select * into pa from public.pre_agendamentos where klingo_marcacoes @> array[v_id] limit 1;');
