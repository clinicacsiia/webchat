-- FLUXOGRAMA: entrada (o paciente sem horário registra a disponibilidade: chat_disponibilidade_registrar; o motor procura vagas: previsao_vigiar -> Edge Function disponibilidade-vigia -> disponibilidade_oportunidades_gravar)
--   -> validação (token da conversa; recurso ligado para esta conversa: klingo_ativo "previsao_modo"; CPF + nascimento conferidos; datas, dias da semana, turno e canais válidos; autorização de notificação explícita)
--   -> processamento (solicitação = PREFERÊNCIA, nunca reserva; oportunidade só quando a oferta REAL da API cruza com as preferências; uma notificação por oferta; limites por dia e total; máquina de estados protegida por gatilho)
--   -> persistência (disponibilidade_pedido, _evento, _oportunidade, _notificacao; nenhum CPF/nome/telefone: só o hash da pessoa e o id da conversa) -> saída (JSON enxuto; mensagem no chat SÓ depois de entrega real e com notificacao_modo ligado; aceitar = voltar ao calendário normal e marcar pelo pipeline klingo_operacao)
-- Versão 2.0 — 14/11/2026 / Mudança: a "previsão" deixa de ser calendário de horários estimados e vira solicitação de disponibilidade futura (docs/reestruturacao-2026-11-14/). pedido_previsao fica como está (0 linhas na produção, mantida só por compatibilidade); nada é apagado.
--
-- Estados: ativa > oportunidade_identificada > notificada > aguardando_resposta > convertida_em_agendamento; saídas: expirada, cancelada (finais, não recebem oferta). Ver gatilho disponibilidade_transicao_trg.
-- Chaves novas (config): previsao_modo (teste), previsao_monitor_modo (nao), notificacao_modo (nao), disponibilidade_max_avisos_dia (2), disponibilidade_max_avisos_total (6), disponibilidade_encerra_conversa (nao).
-- Como voltar atrás: reaplicar supabase/producao/funcoes/{previsao_ativa,previsao_vigiar}.sql; as tabelas novas podem ficar (nada antigo as lê). Depende de: partes 1 e 2.

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 1. Tabelas
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create table if not exists public.disponibilidade_pedido (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  pre_agendamento_id uuid references public.pre_agendamentos (id) on delete set null,
  pessoa_chave text not null,                                   -- hash(cpf|nascimento|nome): identifica a pessoa sem guardar o dado
  paciente_tipo text not null default 'proprio' check (paciente_tipo in ('proprio', 'filho', 'outro')),
  tipo text not null check (tipo in ('exame', 'consulta')),
  procedimentos integer[] not null,
  procedimento_key text not null,
  procedimento_nome text,
  plano text,
  unidade text,
  aceita_outras_unidades boolean not null default true,
  profissional_preferido text,
  aceita_outros_profissionais boolean not null default true,
  data_ini date not null,
  data_fim date not null,
  datas_alternativas boolean not null default false,
  dias_semana smallint[] not null default '{0,1,2,3,4,5,6}',
  turno text not null default 'qualquer' check (turno in ('manha', 'tarde', 'noite', 'qualquer')),
  hora_ini text check (hora_ini is null or hora_ini ~ '^\d{2}:\d{2}$'),
  hora_fim text check (hora_fim is null or hora_fim ~ '^\d{2}:\d{2}$'),
  aceita_notificacao boolean not null default false,
  canais text[] not null default '{}' check (canais <@ array['chat', 'equipe_contato']),
  estado text not null default 'ativa' check (estado in ('ativa', 'oportunidade_identificada', 'notificada', 'aguardando_resposta', 'convertida_em_agendamento', 'expirada', 'cancelada')),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  expira_em timestamptz not null,
  ultima_verificacao_em timestamptz,
  ultima_verificacao_resultado text,
  ultima_oportunidade jsonb,
  ultima_oportunidade_em timestamptz,
  convertida_em timestamptz,
  agendamento_pre_id uuid references public.pre_agendamentos (id) on delete set null,
  constraint disponibilidade_datas_ck check (data_fim >= data_ini),
  constraint disponibilidade_dias_ck check (dias_semana <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[] and cardinality(dias_semana) >= 1),
  constraint disponibilidade_canais_ck check (aceita_notificacao or cardinality(canais) = 0)
);
-- Uma solicitação ABERTA por pessoa + serviço + plano: repetir o pedido atualiza a mesma, não duplica.
create unique index if not exists disponibilidade_aberta_uk on public.disponibilidade_pedido (pessoa_chave, tipo, procedimento_key, coalesce(plano, ''))
  where estado not in ('convertida_em_agendamento', 'expirada', 'cancelada');
create index if not exists disponibilidade_conversa_idx on public.disponibilidade_pedido (conversa_id);
create index if not exists disponibilidade_busca_idx on public.disponibilidade_pedido (estado, ultima_verificacao_em nulls first);

create table if not exists public.disponibilidade_evento (
  id bigint generated always as identity primary key,
  pedido_id uuid not null references public.disponibilidade_pedido (id) on delete cascade,
  em timestamptz not null default now(),
  tipo text not null,
  origem text not null default 'sistema',
  detalhe jsonb not null default '{}'::jsonb
);
create index if not exists disponibilidade_evento_idx on public.disponibilidade_evento (pedido_id, em);

create table if not exists public.disponibilidade_oportunidade (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.disponibilidade_pedido (id) on delete cascade,
  oferta_chave text not null,
  data date not null,
  hora text not null,
  unidade text,
  profissional text,
  estado text not null default 'nova' check (estado in ('nova', 'notificada', 'aceita', 'expirada', 'descartada')),
  encontrada_em timestamptz not null default now(),
  valida_ate timestamptz not null,
  constraint disponibilidade_oportunidade_uk unique (pedido_id, oferta_chave)   -- a mesma vaga nunca gera dois avisos para a mesma solicitação
);

create table if not exists public.disponibilidade_notificacao (
  id uuid primary key default gen_random_uuid(),
  pedido_id uuid not null references public.disponibilidade_pedido (id) on delete cascade,
  oportunidade_id uuid not null unique references public.disponibilidade_oportunidade (id) on delete cascade,
  canal text not null,
  estado text not null check (estado in ('pendente', 'entregue_ao_chat', 'bloqueada_sem_autorizacao', 'bloqueada_limite', 'falhou')),
  criado_em timestamptz not null default now(),
  entregue_em timestamptz,
  detalhe text
);

do $r$ declare t text; begin
  foreach t in array array['disponibilidade_pedido', 'disponibilidade_evento', 'disponibilidade_oportunidade', 'disponibilidade_notificacao'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_equipe', t);
    execute format('create policy %I on public.%I as permissive for select to authenticated using (((select public.papel_atual()) = any (array[''admin'', ''atendente''])))', t || '_equipe', t);
  end loop;
end $r$;
comment on table public.disponibilidade_pedido is 'Solicitação de disponibilidade futura: PREFERÊNCIA do paciente, nunca reserva nem promessa de vaga. Sem CPF/nome/telefone (só hash da pessoa e id da conversa).';

-- Transições válidas (e estados finais imutáveis)
create or replace function public.disponibilidade_transicao_trg() returns trigger
  language plpgsql security definer set search_path to ''
as $function$
begin
  new.atualizado_em := now();
  if new.estado is distinct from old.estado and not exists (
      select 1 from (values ('ativa', 'oportunidade_identificada'), ('ativa', 'expirada'), ('ativa', 'cancelada'), ('ativa', 'convertida_em_agendamento'),
                            ('oportunidade_identificada', 'notificada'), ('oportunidade_identificada', 'ativa'), ('oportunidade_identificada', 'expirada'), ('oportunidade_identificada', 'cancelada'), ('oportunidade_identificada', 'convertida_em_agendamento'),
                            ('notificada', 'aguardando_resposta'), ('notificada', 'ativa'), ('notificada', 'expirada'), ('notificada', 'cancelada'), ('notificada', 'convertida_em_agendamento'),
                            ('aguardando_resposta', 'convertida_em_agendamento'), ('aguardando_resposta', 'ativa'), ('aguardando_resposta', 'expirada'), ('aguardando_resposta', 'cancelada')) t(de, para)
       where t.de = old.estado and t.para = new.estado) then
    raise exception 'Transição inválida da solicitação de disponibilidade: % -> %', old.estado, new.estado using errcode = '23514';
  end if;
  return new;
end $function$;
drop trigger if exists disponibilidade_transicao_trg on public.disponibilidade_pedido;
create trigger disponibilidade_transicao_trg before update on public.disponibilidade_pedido for each row execute function public.disponibilidade_transicao_trg();

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 2. Funções internas
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.disponibilidade_evento_gravar(p_pedido uuid, p_tipo text, p_origem text default 'sistema', p_detalhe jsonb default '{}'::jsonb) returns void
  language sql security definer set search_path to ''
as $function$ insert into public.disponibilidade_evento (pedido_id, tipo, origem, detalhe) values (p_pedido, left(p_tipo, 40), left(p_origem, 40), coalesce(p_detalhe, '{}'::jsonb)) $function$;

-- Muda o estado respeitando a máquina (a regra mora no gatilho) e registra o histórico.
create or replace function public.disponibilidade_mudar_estado(p_pedido uuid, p_para text, p_origem text default 'sistema', p_detalhe jsonb default '{}'::jsonb) returns boolean
  language plpgsql security definer set search_path to ''
as $function$
declare v_de text;
begin
  select estado into v_de from public.disponibilidade_pedido where id = p_pedido for update;
  if v_de is null or v_de = p_para then return false; end if;
  update public.disponibilidade_pedido set estado = p_para,
         convertida_em = case when p_para = 'convertida_em_agendamento' then now() else convertida_em end where id = p_pedido;
  perform public.disponibilidade_evento_gravar(p_pedido, 'estado:' || p_para, p_origem, coalesce(p_detalhe, '{}'::jsonb) || jsonb_build_object('de', v_de));
  return true;
exception when check_violation then return false;
end $function$;

create or replace function public.disponibilidade_pessoa_chave(p_conversa uuid) returns text
  language plpgsql stable security definer set search_path to ''
as $function$
declare d jsonb := public.klingo_dados_conversa(p_conversa); v_nome text;
begin
  if d ->> 'cpf' is null or d ->> 'nascimento' is null then return null; end if;
  select coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), nullif(btrim(c.paciente_nome), ''), nullif(btrim(c.nome_informado), ''), '') into v_nome
    from public.conversas c left join public.pre_agendamentos pa on pa.conversa_id = c.id where c.id = p_conversa;
  return public.klingo_hash((d ->> 'cpf') || '|' || (d ->> 'nascimento') || '|' || coalesce(public.norm_nome(v_nome), ''));
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 3. O que o paciente faz (token da conversa)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.disponibilidade_json(p public.disponibilidade_pedido) returns jsonb
  language sql stable security definer set search_path to ''
as $function$
  select jsonb_build_object('id', p.id, 'estado', p.estado, 'tipo', p.tipo, 'procedimento', p.procedimento_nome, 'plano', p.plano, 'unidade', p.unidade,
    'aceita_outras_unidades', p.aceita_outras_unidades, 'profissional', p.profissional_preferido, 'aceita_outros_profissionais', p.aceita_outros_profissionais,
    'data_ini', p.data_ini, 'data_fim', p.data_fim, 'datas_alternativas', p.datas_alternativas, 'dias_semana', to_jsonb(p.dias_semana), 'turno', p.turno, 'hora_ini', p.hora_ini, 'hora_fim', p.hora_fim,
    'aceita_notificacao', p.aceita_notificacao, 'canais', to_jsonb(p.canais), 'criado_em', p.criado_em, 'expira_em', p.expira_em,
    'oportunidade', (select jsonb_build_object('id', o.id, 'data', o.data, 'hora', o.hora, 'unidade', o.unidade, 'profissional', o.profissional, 'valida_ate', o.valida_ate)
                       from public.disponibilidade_oportunidade o where o.pedido_id = p.id and o.estado = 'notificada' and o.valida_ate > now() order by o.encontrada_em desc limit 1))
$function$;

create or replace function public.disponibilidade_gravar(p_conversa uuid, p_dados jsonb, p_id uuid default null) returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare
  pa public.pre_agendamentos; c public.conversas; d jsonb := public.klingo_dados_conversa(p_conversa); v_procs integer[]; v_pessoa text; v_ini date; v_fim date; v_dias smallint[]; v_turno text; v_canais text[]; v_aceita boolean;
  v_id uuid; v_novo boolean; v_nome text; v_hi text := nullif(p_dados ->> 'hora_ini', ''); v_hf text := nullif(p_dados ->> 'hora_fim', ''); v_tipo_pac text; r public.disponibilidade_pedido;
begin
  select * into c from public.conversas where id = p_conversa;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if pa.id is null then raise exception 'Escolha o exame ou a consulta primeiro.' using errcode = '22023'; end if;
  select array_agg(distinct i.procedimento_id order by i.procedimento_id) into v_procs from public.pre_agendamento_itens i where i.conversa_id = p_conversa and i.ativo and i.procedimento_id is not null;
  if v_procs is null then raise exception 'Escolha o exame ou a consulta primeiro.' using errcode = '22023'; end if;
  v_pessoa := public.disponibilidade_pessoa_chave(p_conversa);
  if v_pessoa is null then raise exception 'Informe o CPF e a data de nascimento antes.' using errcode = '22023'; end if;
  v_ini := greatest(coalesce(nullif(p_dados ->> 'data_ini', '')::date, current_date), current_date);
  v_fim := coalesce(nullif(p_dados ->> 'data_fim', '')::date, v_ini + 60);
  if v_fim < v_ini then raise exception 'A data final precisa ser depois da inicial.' using errcode = '22023'; end if;
  if v_fim > current_date + 365 then raise exception 'O período pode ir até 1 ano.' using errcode = '22023'; end if;
  v_dias := coalesce((select array_agg(distinct x::smallint order by x::smallint) from jsonb_array_elements_text(case when jsonb_typeof(p_dados -> 'dias_semana') = 'array' then p_dados -> 'dias_semana' else '[]'::jsonb end) x where x ~ '^[0-6]$'), '{}'::smallint[]);
  if cardinality(v_dias) = 0 then v_dias := '{0,1,2,3,4,5,6}'::smallint[]; end if;
  v_turno := coalesce(nullif(p_dados ->> 'turno', ''), 'qualquer');
  if v_turno not in ('manha', 'tarde', 'noite', 'qualquer') then raise exception 'Turno inválido.' using errcode = '22023'; end if;
  if (v_hi is not null and v_hi !~ '^\d{2}:\d{2}$') or (v_hf is not null and v_hf !~ '^\d{2}:\d{2}$') or (v_hi is not null and v_hf is not null and v_hf <= v_hi) then raise exception 'Horário inválido.' using errcode = '22023'; end if;
  v_aceita := coalesce((p_dados ->> 'aceita_notificacao')::boolean, false);
  v_canais := case when v_aceita then coalesce((select array_agg(distinct x) from jsonb_array_elements_text(case when jsonb_typeof(p_dados -> 'canais') = 'array' then p_dados -> 'canais' else '["chat"]'::jsonb end) x where x in ('chat', 'equipe_contato')), '{}'::text[]) else '{}'::text[] end;
  v_tipo_pac := case when coalesce(c.paciente_tipo, 'proprio') in ('filho', 'outro') then c.paciente_tipo else 'proprio' end;
  select string_agg(distinct p.nome, ' + ') into v_nome from public.catalogo_procedimento p where p.id = any (v_procs);

  insert into public.disponibilidade_pedido (id, conversa_id, pre_agendamento_id, pessoa_chave, paciente_tipo, tipo, procedimentos, procedimento_key, procedimento_nome, plano, unidade, aceita_outras_unidades,
      profissional_preferido, aceita_outros_profissionais, data_ini, data_fim, datas_alternativas, dias_semana, turno, hora_ini, hora_fim, aceita_notificacao, canais, expira_em)
  values (coalesce(p_id, gen_random_uuid()), p_conversa, pa.id, v_pessoa, v_tipo_pac, coalesce(pa.tipo, 'exame'), v_procs, array_to_string(v_procs, ','), left(v_nome, 200), pa.plano, nullif(btrim(p_dados ->> 'unidade'), ''),
      coalesce((p_dados ->> 'aceita_outras_unidades')::boolean, true), nullif(btrim(p_dados ->> 'profissional'), ''), coalesce((p_dados ->> 'aceita_outros_profissionais')::boolean, true), v_ini, v_fim,
      coalesce((p_dados ->> 'datas_alternativas')::boolean, false), v_dias, v_turno, v_hi, v_hf, v_aceita, v_canais, ((v_fim + 1)::timestamp at time zone 'America/Bahia'))
  on conflict (pessoa_chave, tipo, procedimento_key, coalesce(plano, '')) where estado not in ('convertida_em_agendamento', 'expirada', 'cancelada')
  do update set conversa_id = excluded.conversa_id, pre_agendamento_id = excluded.pre_agendamento_id, unidade = excluded.unidade, aceita_outras_unidades = excluded.aceita_outras_unidades,
      profissional_preferido = excluded.profissional_preferido, aceita_outros_profissionais = excluded.aceita_outros_profissionais, data_ini = excluded.data_ini, data_fim = excluded.data_fim,
      datas_alternativas = excluded.datas_alternativas, dias_semana = excluded.dias_semana, turno = excluded.turno, hora_ini = excluded.hora_ini, hora_fim = excluded.hora_fim,
      aceita_notificacao = excluded.aceita_notificacao, canais = excluded.canais, expira_em = excluded.expira_em, ultima_verificacao_em = null
  returning id, (xmax = 0) into v_id, v_novo;
  perform public.disponibilidade_evento_gravar(v_id, case when v_novo then 'criada' else 'editada' end, 'paciente',
      jsonb_build_object('data_ini', v_ini, 'data_fim', v_fim, 'turno', v_turno, 'dias', cardinality(v_dias), 'notificar', v_aceita));
  select * into r from public.disponibilidade_pedido where id = v_id;
  return public.disponibilidade_json(r);
end $function$;

-- Registrar: grava a preferência, avisa o paciente com clareza que NÃO é agendamento e segue o fluxo do pedido (dados que faltam) como "sem horário".
create or replace function public.chat_disponibilidade_registrar(p_conversa uuid, p_token text, p_dados jsonb) returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare v_r jsonb; v_texto text; v_prox text;
begin
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  if not public.klingo_ativo(p_conversa, 'previsao_modo') then raise exception 'Este recurso ainda não está disponível para você. A equipe pode ajudar.' using errcode = 'P0001'; end if;
  if (select count(*) from public.mensagens where conversa_id = p_conversa and autor = 'cliente' and criado_em > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens em pouco tempo. Aguarde um instante.' using errcode = '54000';
  end if;
  v_r := public.disponibilidade_gravar(p_conversa, coalesce(p_dados, '{}'::jsonb));
  v_texto := 'Registrei a sua disponibilidade para ' || coalesce(v_r ->> 'procedimento', 'o atendimento') || ', de ' || to_char((v_r ->> 'data_ini')::date, 'DD/MM') || ' a ' || to_char((v_r ->> 'data_fim')::date, 'DD/MM') || '.'
    || E'\n\nIsso NÃO é um agendamento e não reserva horário: é um pedido para avisarmos você quando surgir uma vaga compatível. '
    || case when (v_r ->> 'aceita_notificacao')::boolean then 'Quando isso acontecer, você receberá um aviso aqui no chat e poderá tentar agendar na hora.' else 'Você não autorizou avisos; para acompanhar, volte aqui e toque em "Minha disponibilidade".' end;
  perform public.fluxo_dizer(p_conversa, v_texto, jsonb_build_object('tipo', 'disponibilidade_registrada', 'id', v_r ->> 'id'));
  perform public.fluxo_set(p_conversa, jsonb_build_object('sem_horario', true, 'disponibilidade', v_r ->> 'id'));
  perform public.fluxo_nota(p_conversa, 'SOLICITAÇÃO DE DISPONIBILIDADE FUTURA registrada (NÃO é agendamento e não reserva horário). Procura automática de vaga: ativa. Nada a fazer pela equipe agora.');
  -- segue o fluxo do pedido (nome, contato, confirmação) como "sem horário": esses dados também servem para marcar quando o paciente aceitar uma vaga
  v_prox := public.fluxo_proximo(p_conversa);
  if v_prox = 'pronto' then perform public.fluxo_finalizar(p_conversa); else perform public.fluxo_perguntar(p_conversa, v_prox, null); end if;
  if public.klingo_cfg('disponibilidade_encerra_conversa', 'nao') = 'sim' and not exists (select 1 from public.klingo_operacao o where o.conversa_id = p_conversa and o.estado in ('pendente', 'executando', 'incerto')) then
    update public.conversas set status = 'encerrada', encerrada_em = now(), motivo_encerramento = 'outro', encerramento_origem = 'sistema' where id = p_conversa and status <> 'encerrada' and primeiro_humano_em is null;
  end if;
  return jsonb_build_object('ok', true, 'solicitacao', v_r);
end $function$;

create or replace function public.chat_disponibilidade_ver(p_conversa uuid, p_token text) returns jsonb
  language plpgsql stable security definer set search_path to ''
as $function$
declare v_pessoa text;
begin
  perform public.chat_valida(p_conversa, p_token);
  v_pessoa := public.disponibilidade_pessoa_chave(p_conversa);
  return jsonb_build_object('solicitacoes', coalesce((select jsonb_agg(public.disponibilidade_json(p) order by p.criado_em desc) from public.disponibilidade_pedido p
      where (p.conversa_id = p_conversa or (v_pessoa is not null and p.pessoa_chave = v_pessoa)) and (p.estado not in ('expirada', 'cancelada', 'convertida_em_agendamento') or p.atualizado_em > now() - interval '30 days')), '[]'::jsonb));
end $function$;

create or replace function public.disponibilidade_do_paciente(p_conversa uuid, p_id uuid) returns public.disponibilidade_pedido
  language plpgsql stable security definer set search_path to ''
as $function$
declare r public.disponibilidade_pedido; v_pessoa text := public.disponibilidade_pessoa_chave(p_conversa);
begin
  select * into r from public.disponibilidade_pedido p where p.id = p_id and (p.conversa_id = p_conversa or (v_pessoa is not null and p.pessoa_chave = v_pessoa));
  if r.id is null then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  return r;
end $function$;

create or replace function public.chat_disponibilidade_alterar(p_conversa uuid, p_token text, p_id uuid, p_dados jsonb) returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare r public.disponibilidade_pedido; v_r jsonb;
begin
  perform public.chat_valida(p_conversa, p_token);
  r := public.disponibilidade_do_paciente(p_conversa, p_id);
  if r.estado in ('expirada', 'cancelada', 'convertida_em_agendamento') then raise exception 'Esta solicitação já terminou. Faça uma nova.' using errcode = 'P0001'; end if;
  v_r := public.disponibilidade_gravar(p_conversa, coalesce(p_dados, '{}'::jsonb) || jsonb_build_object('unidade', coalesce(p_dados ->> 'unidade', r.unidade)), r.id);
  return jsonb_build_object('ok', true, 'solicitacao', v_r);
end $function$;

create or replace function public.chat_disponibilidade_cancelar(p_conversa uuid, p_token text, p_id uuid) returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare r public.disponibilidade_pedido;
begin
  perform public.chat_valida(p_conversa, p_token);
  r := public.disponibilidade_do_paciente(p_conversa, p_id);
  if r.estado in ('expirada', 'cancelada', 'convertida_em_agendamento') then return jsonb_build_object('ok', true, 'estado', r.estado, 'ja_terminada', true); end if;
  perform public.disponibilidade_mudar_estado(r.id, 'cancelada', 'paciente');
  update public.disponibilidade_oportunidade set estado = 'descartada' where pedido_id = r.id and estado in ('nova', 'notificada');
  return jsonb_build_object('ok', true, 'estado', 'cancelada');
end $function$;

-- O paciente tocou em "Ver horários" no aviso: o pedido volta ao calendário NORMAL (consulta nova à API; nada foi reservado). Recusar = a solicitação volta a procurar.
create or replace function public.chat_disponibilidade_responder(p_conversa uuid, p_token text, p_id uuid, p_aceita boolean) returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare r public.disponibilidade_pedido; o public.disponibilidade_oportunidade; pa public.pre_agendamentos;
begin
  perform public.chat_valida(p_conversa, p_token);
  perform set_config('app.conversa', p_conversa::text, true);
  r := public.disponibilidade_do_paciente(p_conversa, p_id);
  select * into o from public.disponibilidade_oportunidade where pedido_id = r.id and estado = 'notificada' order by encontrada_em desc limit 1;
  if o.id is null or o.valida_ate <= now() then
    perform public.disponibilidade_mudar_estado(r.id, 'ativa', 'paciente', jsonb_build_object('motivo', 'oportunidade_expirada'));
    return jsonb_build_object('ok', false, 'motivo', 'oportunidade_expirada', 'mensagem', 'Esse horário já não está mais disponível. Continuamos procurando para você.');
  end if;
  if not p_aceita then
    update public.disponibilidade_oportunidade set estado = 'descartada' where id = o.id;
    perform public.disponibilidade_mudar_estado(r.id, 'ativa', 'paciente', jsonb_build_object('motivo', 'recusou'));
    return jsonb_build_object('ok', true, 'acao', 'continuar_procurando');
  end if;
  select * into pa from public.pre_agendamentos where conversa_id = p_conversa;
  if pa.id is null or pa.status in ('agendado', 'cancelado') then return jsonb_build_object('ok', false, 'motivo', 'pedido_' || coalesce(pa.status, 'inexistente')); end if;
  update public.disponibilidade_oportunidade set estado = 'aceita' where id = o.id;
  perform public.disponibilidade_mudar_estado(r.id, 'aguardando_resposta', 'paciente', jsonb_build_object('oportunidade', o.id));
  update public.pre_agendamentos set status = 'rascunho', escolha_horario = null, data_desejada = null, hora_desejada = null, etapa = 'data_hora', conferencia_status = null, conferencia_detalhe = null, atualizado_em = now()
   where conversa_id = p_conversa and status = 'pronto';
  update public.conversas set status = case when status = 'encerrada' then 'aguardando' else status end where id = p_conversa;
  perform public.fluxo_set(p_conversa, '{"sem_horario": false, "confirmado": false, "oferta_pendente": null}'::jsonb);
  perform public.fluxo_perguntar(p_conversa, 'horario', 'Vou conferir os horários disponíveis agora. Escolha o que preferir; só fica marcado depois da confirmação.');
  return jsonb_build_object('ok', true, 'acao', 'abrir_calendario');
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 4. Motor de busca (rodado por previsao_vigiar a cada 10 min; a consulta à API é da Edge Function disponibilidade-vigia)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.disponibilidade_alvos(p_max integer default 10) returns jsonb
  language sql stable security definer set search_path to ''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object('pedido_id', x.id, 'conversa_id', x.conversa_id, 'de', greatest(x.data_ini, (now() at time zone 'America/Bahia')::date), 'ate', x.data_fim, 'modo', x.modo) order by x.ultima_verificacao_em nulls first), '[]'::jsonb)
    from (select p.*, public.klingo_modo(p.conversa_id, 'previsao_monitor_modo') as modo from public.disponibilidade_pedido p
           where p.estado = 'ativa' and p.expira_em > now() and (p.ultima_verificacao_em is null or p.ultima_verificacao_em < now() - interval '9 minutes')
           order by p.ultima_verificacao_em nulls first limit greatest(p_max, 1) * 4) x
   where x.modo in ('sombra', 'teste', 'sim') and x.data_fim >= (now() at time zone 'America/Bahia')::date limit greatest(p_max, 1)
$function$;

create or replace function public.disponibilidade_verificada(p_pedido uuid, p_resultado text) returns void
  language plpgsql security definer set search_path to ''
as $function$
declare v_ant text;
begin
  select ultima_verificacao_resultado into v_ant from public.disponibilidade_pedido where id = p_pedido;
  update public.disponibilidade_pedido set ultima_verificacao_em = now(), ultima_verificacao_resultado = left(p_resultado, 40) where id = p_pedido;
  if v_ant is distinct from left(p_resultado, 40) then perform public.disponibilidade_evento_gravar(p_pedido, 'verificada', 'sistema', jsonb_build_object('resultado', left(p_resultado, 40))); end if;
end $function$;

-- A oferta REAL cruza com as preferências? (dados da solicitação x oferta da API)
create or replace function public.disponibilidade_compativel(r public.disponibilidade_pedido, p_data date, p_hora text, p_unidade text, p_prof text) returns boolean
  language sql stable set search_path to ''
as $function$
  select p_data >= (now() at time zone 'America/Bahia')::date and (p_data + p_hora::time) > (now() at time zone 'America/Bahia')
     and p_data between r.data_ini and r.data_fim + case when r.datas_alternativas then 7 else 0 end
     and extract(dow from p_data)::smallint = any (r.dias_semana)
     and case r.turno when 'manha' then p_hora < '12:00' when 'tarde' then p_hora >= '12:00' and p_hora < '18:00' when 'noite' then p_hora >= '18:00' else true end
     and (r.hora_ini is null or p_hora >= r.hora_ini) and (r.hora_fim is null or p_hora <= r.hora_fim)
     and (r.unidade is null or r.aceita_outras_unidades or public.norm_nome(p_unidade) = public.norm_nome(r.unidade))
     and (r.profissional_preferido is null or r.aceita_outros_profissionais or public.klingo_prof_confere(p_prof, r.profissional_preferido))
$function$;

-- Recebe as ofertas REAIS que a Edge Function achou e registra no máximo UMA oportunidade nova (a mais cedo), sem repetir vaga já avisada. Em sombra só conta.
create or replace function public.disponibilidade_oportunidades_gravar(p_pedido uuid, p_ofertas jsonb, p_sombra boolean default false) returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare r public.disponibilidade_pedido; o record; v_opp uuid; v_n integer := 0; v_compat integer := 0; v_max_dia integer; v_max_total integer; v_bloq text; v_canal text := 'chat'; v_notif_estado text;
begin
  select * into r from public.disponibilidade_pedido where id = p_pedido for update;
  if r.id is null or r.estado <> 'ativa' or r.expira_em <= now() then return jsonb_build_object('ok', false, 'motivo', 'estado_' || coalesce(r.estado, 'inexistente')); end if;
  for o in select (x ->> 'chave') as chave, (x ->> 'data')::date as data, (x ->> 'hora') as hora, (x ->> 'unidade') as unidade, (x ->> 'profissional') as prof
             from jsonb_array_elements(case when jsonb_typeof(p_ofertas) = 'array' then p_ofertas else '[]'::jsonb end) x
            where (x ->> 'data') ~ '^\d{4}-\d{2}-\d{2}$' and (x ->> 'hora') ~ '^\d{2}:\d{2}$' and nullif(x ->> 'chave', '') is not null order by 2, 3 loop
    if not public.disponibilidade_compativel(r, o.data, o.hora, o.unidade, o.prof) then continue; end if;
    v_compat := v_compat + 1;
    if p_sombra then continue; end if;
    if exists (select 1 from public.disponibilidade_oportunidade where pedido_id = r.id and oferta_chave = o.chave) then continue; end if;   -- já avisada antes
    insert into public.disponibilidade_oportunidade (pedido_id, oferta_chave, data, hora, unidade, profissional, valida_ate) values (r.id, left(o.chave, 120), o.data, o.hora, left(o.unidade, 120), left(o.prof, 120), now() + interval '2 hours') returning id into v_opp;
    update public.disponibilidade_pedido set ultima_oportunidade = jsonb_build_object('data', o.data, 'hora', o.hora, 'unidade', o.unidade), ultima_oportunidade_em = now() where id = r.id;
    perform public.disponibilidade_mudar_estado(r.id, 'oportunidade_identificada', 'sistema', jsonb_build_object('data', o.data, 'hora', o.hora));
    v_n := v_n + 1;
    -- notificação: só com autorização, dentro dos limites; a entrega real é de disponibilidade_entregar_pendentes (e só com notificacao_modo ligado)
    v_max_dia := coalesce(nullif(public.klingo_cfg('disponibilidade_max_avisos_dia', '2'), '')::integer, 2); v_max_total := coalesce(nullif(public.klingo_cfg('disponibilidade_max_avisos_total', '6'), '')::integer, 6);
    v_notif_estado := case when not r.aceita_notificacao or not ('chat' = any (r.canais)) then 'bloqueada_sem_autorizacao'
                           when (select count(*) from public.disponibilidade_notificacao n where n.pedido_id = r.id and n.estado = 'entregue_ao_chat' and n.entregue_em > now() - interval '24 hours') >= v_max_dia
                             or (select count(*) from public.disponibilidade_notificacao n where n.pedido_id = r.id and n.estado = 'entregue_ao_chat') >= v_max_total then 'bloqueada_limite'
                           else 'pendente' end;
    insert into public.disponibilidade_notificacao (pedido_id, oportunidade_id, canal, estado) values (r.id, v_opp, v_canal, v_notif_estado);
    perform public.disponibilidade_evento_gravar(r.id, 'oportunidade', 'sistema', jsonb_build_object('notificacao', v_notif_estado));
    exit;
  end loop;
  if p_sombra then perform public.klingo_medir('disponibilidade_sombra_compativeis', v_compat); end if;
  return jsonb_build_object('ok', true, 'compativeis', v_compat, 'novas', v_n);
end $function$;

-- Entrega as notificações pendentes: mensagem no CHAT (único canal com entrega comprovada: a linha existe na conversa e o aviso push do chat segue o fluxo normal). NÃO afirma agendamento.
create or replace function public.disponibilidade_entregar_pendentes() returns integer
  language plpgsql security definer set search_path to ''
as $function$
declare n record; v_ent integer := 0; v_msg bigint;
begin
  for n in select nt.id, nt.pedido_id, nt.oportunidade_id, p.conversa_id, p.procedimento_nome, o.valida_ate, o.estado as ostado from public.disponibilidade_notificacao nt
             join public.disponibilidade_pedido p on p.id = nt.pedido_id join public.disponibilidade_oportunidade o on o.id = nt.oportunidade_id
            where nt.estado = 'pendente' and p.estado = 'oportunidade_identificada' order by nt.criado_em limit 50 loop
    continue when not public.klingo_ativo(n.conversa_id, 'notificacao_modo');   -- sem a chave ligada, NADA é "enviado": fica na fila, visível para a equipe
    if n.valida_ate <= now() or n.ostado <> 'nova' then update public.disponibilidade_notificacao set estado = 'falhou', detalhe = 'oportunidade_expirada' where id = n.id; continue; end if;
    begin
      v_msg := public.fluxo_dizer(n.conversa_id, 'Encontramos uma possibilidade de horário compatível com a sua solicitação (' || coalesce(n.procedimento_nome, 'atendimento') || '). Consulte a disponibilidade atual para tentar realizar o agendamento: o horário ainda NÃO está reservado para você.',
        jsonb_build_object('tipo', 'disponibilidade_oportunidade', 'solicitacao', n.pedido_id, 'oportunidade', n.oportunidade_id));
      update public.disponibilidade_notificacao set estado = 'entregue_ao_chat', entregue_em = now(), detalhe = 'mensagem ' || v_msg where id = n.id;
      update public.disponibilidade_oportunidade set estado = 'notificada' where id = n.oportunidade_id;
      perform public.disponibilidade_mudar_estado(n.pedido_id, 'notificada', 'sistema', jsonb_build_object('canal', 'chat'));
      v_ent := v_ent + 1;
    exception when others then
      update public.disponibilidade_notificacao set estado = 'falhou', detalhe = left(sqlerrm, 120) where id = n.id;
    end;
  end loop;
  return v_ent;
end $function$;

-- Rotina (a cada 10 min, já agendada como "previsao-vigia"): expira, devolve oportunidade vencida, entrega avisos e dispara a busca na API.
create or replace function public.disponibilidade_vigiar() returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare v_exp integer := 0; v_ent integer; v_base text := public.klingo_cfg('klingo_funcoes_base', ''); v_seg text := public.klingo_segredo(); v_alvos jsonb; v_disp boolean := false; r record;
begin
  if not pg_try_advisory_xact_lock(hashtext('disponibilidade_vigiar')) then return jsonb_build_object('ocupado', true); end if;
  -- expirar: passou do fim do período
  v_exp := 0;
  for r in select id from public.disponibilidade_pedido where estado in ('ativa', 'oportunidade_identificada', 'notificada', 'aguardando_resposta') and expira_em <= now() loop
    if public.disponibilidade_mudar_estado(r.id, 'expirada', 'sistema', jsonb_build_object('motivo', 'periodo_terminou')) then v_exp := v_exp + 1; end if;
  end loop;
  update public.disponibilidade_oportunidade set estado = 'descartada' where estado in ('nova', 'notificada') and pedido_id in (select id from public.disponibilidade_pedido where estado in ('expirada', 'cancelada', 'convertida_em_agendamento'));
  -- oportunidade vencida sem resposta: a solicitação volta a procurar
  for r in select distinct o.pedido_id from public.disponibilidade_oportunidade o where o.estado in ('nova', 'notificada') and o.valida_ate <= now() loop
    update public.disponibilidade_oportunidade set estado = 'expirada' where pedido_id = r.pedido_id and estado in ('nova', 'notificada') and valida_ate <= now();
    update public.disponibilidade_notificacao set estado = 'falhou', detalhe = 'oportunidade_expirada' where pedido_id = r.pedido_id and estado = 'pendente';
    perform public.disponibilidade_mudar_estado(r.pedido_id, 'ativa', 'sistema', jsonb_build_object('motivo', 'oportunidade_expirou'));
  end loop;
  v_ent := public.disponibilidade_entregar_pendentes();
  v_alvos := public.disponibilidade_alvos(10);
  if jsonb_array_length(v_alvos) > 0 and v_base <> '' and v_seg is not null then
    begin
      perform net.http_post(url := v_base || 'disponibilidade-vigia', headers := jsonb_build_object('Content-Type', 'application/json', 'x-klingo-segredo', v_seg), body := jsonb_build_object('alvos', v_alvos), timeout_milliseconds := 110000);
      v_disp := true;
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('expiradas', v_exp, 'entregues', v_ent, 'alvos', jsonb_array_length(v_alvos), 'disparou', v_disp);
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 5. Conversão: agendamento confirmado (pela API ou pela equipe) fecha a solicitação; a previsão antiga vira este motor
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.disponibilidade_converter_trg() returns trigger
  language plpgsql security definer set search_path to ''
as $function$
declare r record; v_procs integer[];
begin
  if new.status = 'agendado' and old.status is distinct from 'agendado' then
    select array_agg(i.procedimento_id) into v_procs from public.pre_agendamento_itens i where i.conversa_id = new.conversa_id and i.ativo and i.procedimento_id is not null;
    for r in select id from public.disponibilidade_pedido where (conversa_id = new.conversa_id or pre_agendamento_id = new.id) and estado in ('ativa', 'oportunidade_identificada', 'notificada', 'aguardando_resposta')
                and (v_procs is null or procedimentos && v_procs) loop
      update public.disponibilidade_pedido set agendamento_pre_id = new.id where id = r.id;
      perform public.disponibilidade_mudar_estado(r.id, 'convertida_em_agendamento', case when new.agendado_origem = 'chat_api' then 'api' else 'equipe' end, jsonb_build_object('origem', new.agendado_origem));
      update public.disponibilidade_oportunidade set estado = 'aceita' where pedido_id = r.id and estado in ('nova', 'notificada');
    end loop;
  end if;
  return new;
end $function$;
drop trigger if exists disponibilidade_converter_trg on public.pre_agendamentos;
create trigger disponibilidade_converter_trg after update of status on public.pre_agendamentos for each row execute function public.disponibilidade_converter_trg();

-- A rotina "previsao-vigia" (pg_cron, 10 min) continua com o mesmo nome e passa a rodar o motor novo. A lista de previsão antiga (grade) não é mais usada.
create or replace function public.previsao_vigiar() returns jsonb
  language sql security definer set search_path to ''
as $function$ select public.disponibilidade_vigiar() $function$;
create or replace function public.previsao_ativa(p_conversa uuid) returns boolean
  language sql stable security definer set search_path to ''
as $function$ select false $function$;   -- o assistente antigo de "lista de espera" (turno/período/antecedência) acabou: o caminho é chat_disponibilidade_registrar

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 6. Painel da equipe
-- ---------------------------------------------------------------------------------------------------------------------------------------------
create or replace function public.painel_disponibilidade_lista(p_estado text default null) returns jsonb
  language plpgsql stable security definer set search_path to ''
as $function$
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'contagem', coalesce((select jsonb_object_agg(estado, n) from (select estado, count(*) n from public.disponibilidade_pedido group by estado) x), '{}'::jsonb),
    'itens', coalesce((select jsonb_agg(q.i order by q.prioridade, q.criado_em desc) from (
      select jsonb_build_object('id', p.id, 'conversa_id', p.conversa_id, 'paciente', coalesce(nullif(btrim(pa.paciente ->> 'nome'), ''), nullif(btrim(c.paciente_nome), ''), nullif(btrim(c.nome_informado), ''), ct.nome),
               'paciente_tipo', p.paciente_tipo, 'tipo', p.tipo, 'procedimento', p.procedimento_nome, 'plano', p.plano, 'unidade', p.unidade, 'data_ini', p.data_ini, 'data_fim', p.data_fim, 'dias_semana', to_jsonb(p.dias_semana),
               'turno', p.turno, 'estado', p.estado, 'criado_em', p.criado_em, 'expira_em', p.expira_em, 'ultima_verificacao_em', p.ultima_verificacao_em, 'ultima_verificacao_resultado', p.ultima_verificacao_resultado,
               'ultima_oportunidade', p.ultima_oportunidade, 'ultima_oportunidade_em', p.ultima_oportunidade_em, 'aceita_notificacao', p.aceita_notificacao, 'canais', to_jsonb(p.canais), 'conversa_status', c.status,
               'notificacao', (select n.estado from public.disponibilidade_notificacao n where n.pedido_id = p.id order by n.criado_em desc limit 1),
               'precisa_humano', exists (select 1 from public.disponibilidade_notificacao n where n.pedido_id = p.id and n.estado in ('bloqueada_sem_autorizacao', 'falhou') and n.criado_em > now() - interval '7 days') and p.estado in ('ativa', 'oportunidade_identificada'),
               'historico', coalesce((select jsonb_agg(jsonb_build_object('em', e.em, 'tipo', e.tipo, 'origem', e.origem) order by e.em desc) from (select * from public.disponibilidade_evento ev where ev.pedido_id = p.id order by ev.em desc limit 8) e), '[]'::jsonb)) as i,
             case p.estado when 'oportunidade_identificada' then 0 when 'notificada' then 1 when 'aguardando_resposta' then 2 when 'ativa' then 3 else 4 end as prioridade, p.criado_em
        from public.disponibilidade_pedido p join public.conversas c on c.id = p.conversa_id join public.contatos ct on ct.id = c.contato_id left join public.pre_agendamentos pa on pa.conversa_id = p.conversa_id
       where p_estado is null or p_estado = '' or p.estado = p_estado limit 500) q), '[]'::jsonb));
end $function$;

create or replace function public.painel_disponibilidade_cancelar(p_id uuid, p_motivo text default null) returns jsonb
  language plpgsql security definer set search_path to ''
as $function$
declare r public.disponibilidade_pedido;
begin
  if coalesce((select public.papel_atual()), '') not in ('admin', 'atendente') then raise exception 'Somente a equipe.' using errcode = '42501'; end if;
  select * into r from public.disponibilidade_pedido where id = p_id;
  if r.id is null then raise exception 'Solicitação não encontrada.' using errcode = 'P0002'; end if;
  if r.estado in ('expirada', 'cancelada', 'convertida_em_agendamento') then return jsonb_build_object('ok', true, 'estado', r.estado, 'ja_terminada', true); end if;
  perform public.disponibilidade_mudar_estado(r.id, 'cancelada', 'equipe:' || coalesce(auth.uid()::text, '?'), jsonb_build_object('motivo', left(coalesce(p_motivo, ''), 200)));
  update public.disponibilidade_oportunidade set estado = 'descartada' where pedido_id = r.id and estado in ('nova', 'notificada');
  return jsonb_build_object('ok', true, 'estado', 'cancelada');
end $function$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- 7. Permissões (paciente = só pelas funções chat_*, que conferem o token; equipe = painel_*; o resto só o service_role/rotinas)
-- ---------------------------------------------------------------------------------------------------------------------------------------------
do $g$ declare f text; begin
  foreach f in array array[
    'disponibilidade_transicao_trg()', 'disponibilidade_evento_gravar(uuid, text, text, jsonb)', 'disponibilidade_mudar_estado(uuid, text, text, jsonb)', 'disponibilidade_pessoa_chave(uuid)', 'disponibilidade_json(public.disponibilidade_pedido)',
    'disponibilidade_gravar(uuid, jsonb, uuid)', 'disponibilidade_do_paciente(uuid, uuid)', 'disponibilidade_alvos(integer)', 'disponibilidade_verificada(uuid, text)',
    'disponibilidade_compativel(public.disponibilidade_pedido, date, text, text, text)', 'disponibilidade_oportunidades_gravar(uuid, jsonb, boolean)', 'disponibilidade_entregar_pendentes()', 'disponibilidade_vigiar()',
    'disponibilidade_converter_trg()', 'previsao_vigiar()', 'previsao_ativa(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['chat_disponibilidade_registrar(uuid, text, jsonb)', 'chat_disponibilidade_ver(uuid, text)', 'chat_disponibilidade_alterar(uuid, text, uuid, jsonb)', 'chat_disponibilidade_cancelar(uuid, text, uuid)', 'chat_disponibilidade_responder(uuid, text, uuid, boolean)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated, service_role', f);
  end loop;
  foreach f in array array['painel_disponibilidade_lista(text)', 'painel_disponibilidade_cancelar(uuid, text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $g$;

select set_config('app.origem', 'migracao:webchat-v2.0', false), set_config('app.justificativa', 'Migração v2.0: limites do aviso de disponibilidade futura e política de encerramento (desligada).', false);
insert into public.config (chave, valor) values ('disponibilidade_max_avisos_dia', '2'), ('disponibilidade_max_avisos_total', '6'), ('disponibilidade_encerra_conversa', 'nao') on conflict (chave) do nothing;
select set_config('app.origem', '', false), set_config('app.justificativa', '', false);
