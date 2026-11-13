-- RETRATO DA ESTRUTURA DO BANCO DE PRODUÇÃO (projeto webchat-atendimento). GERADO: não editar à mão.
-- Tirado em 2026-11-11T23:06:02+00:00 · Postgres 17.11. Só estrutura: nenhuma linha de tabela, nenhum valor de configuração.
-- Serve de referência e para os testes. NÃO rodar inteiro sobre a produção. Como refazer: supabase/producao/LEIAME.md.

-- ===== Extensões =====
-- pg_cron 1.6.4 (esquema pg_catalog)
-- pg_net 0.20.4 (esquema extensions)
-- pg_stat_statements 1.11 (esquema extensions)
-- pgcrypto 1.3 (esquema extensions)
-- plpgsql 1.0 (esquema pg_catalog)
-- supabase_vault 0.3.1 (esquema vault)
-- unaccent 1.1 (esquema extensions)
-- uuid-ossp 1.1 (esquema extensions)

-- ===== Limite de tempo por papel =====
-- anon: statement_timeout=3s
-- authenticated: statement_timeout=8s
-- authenticator: session_preload_libraries=supautils, safeupdate, statement_timeout=8s, lock_timeout=8s
-- service_role: sem limite

-- ===== Tabelas (114) =====

create table public.agenda_ao_vivo (
  dia date not null,
  lendo_desde timestamp with time zone,
  lido_em timestamp with time zone,
  ok boolean default false not null,
  erro text,
  atualizado_em timestamp with time zone default now() not null,
  constraint agenda_ao_vivo_pkey PRIMARY KEY (dia)
);
comment on table public.agenda_ao_vivo is 'Leitura ao vivo da agenda do Klingo, por dia: lido_em = quando a última leitura bem-sucedida COMEÇOU; lendo_desde = leitura em andamento (uma por dia). Sem dado de paciente. Só funções do banco e service_role.';
alter table public.agenda_ao_vivo enable row level security;

create table public.agenda_ao_vivo_pedido (
  conversa_id uuid not null,
  em timestamp with time zone default now() not null
);
CREATE INDEX agenda_ao_vivo_pedido_conversa ON public.agenda_ao_vivo_pedido USING btree (conversa_id, em DESC);
CREATE INDEX agenda_ao_vivo_pedido_em ON public.agenda_ao_vivo_pedido USING btree (em);
alter table public.agenda_ao_vivo_pedido enable row level security;

create table public.agenda_modalidade_local (
  modalidade text not null,
  local_padrao text not null,
  constraint agenda_modalidade_local_pkey PRIMARY KEY (modalidade)
);
comment on table public.agenda_modalidade_local is 'Em que sala cada modalidade é feita (expressão regular sobre o nome do local na grade). Impede oferecer, por exemplo, uma ressonância num consultório de ultrassom que tenha o exame cadastrado por engano.';
alter table public.agenda_modalidade_local enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.agenda_ocupacao (
  inicio timestamp without time zone not null,
  profissional text not null,
  unidade text not null,
  fonte text default 'marcada'::text not null,
  qtd integer default 1 not null,
  procedimento text,
  reserva_min integer,
  local text,
  visto_em timestamp with time zone default now() not null,
  primeira_vez timestamp with time zone default now(),
  constraint agenda_ocupacao_fonte_check CHECK ((fonte = ANY (ARRAY['marcada'::text, 'bloqueada'::text]))),
  constraint agenda_ocupacao_pkey PRIMARY KEY (inicio, profissional, unidade, fonte)
);
comment on table public.agenda_ocupacao is 'Horários já ocupados no Klingo (marcados ou bloqueados), vindos dos relatórios #7 e #47. SEM dado de paciente: só quando, quem atende e onde. Linhas não vistas na última atualização completa (visto_em < agenda_ocupacao_meta.valido_desde) são ignoradas.';
CREATE INDEX agenda_ocupacao_inicio ON public.agenda_ocupacao USING btree (inicio);
alter table public.agenda_ocupacao enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.agenda_ocupacao_meta (
  id integer default 1 not null,
  valido_desde timestamp with time zone,
  atualizado_em timestamp with time zone,
  linhas integer,
  conferindo_ate timestamp with time zone,
  constraint agenda_ocupacao_meta_id_check CHECK ((id = 1)),
  constraint agenda_ocupacao_meta_pkey PRIMARY KEY (id)
);
alter table public.agenda_ocupacao_meta enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.agenda_regra_duracao (
  modalidade text not null,
  minutos integer not null,
  constraint agenda_regra_duracao_minutos_check CHECK (((minutos >= 5) AND (minutos <= 240))),
  constraint agenda_regra_duracao_pkey PRIMARY KEY (modalidade)
);
comment on table public.agenda_regra_duracao is 'Quanto tempo reservar por exame, por modalidade, quando o tempo da agenda do Klingo (10 min) é menor que o exame real. Ajustável pela clínica.';
alter table public.agenda_regra_duracao enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.agendamento_fechamento (
  id bigint generated always as identity not null,
  pre_id uuid,
  conversa_id uuid not null,
  chave text not null,
  exames text,
  quando timestamp without time zone,
  desfecho text not null,
  origem text not null,
  por uuid,
  nota text,
  remarcacao text,
  remarcacao_conversa uuid,
  fechado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  constraint agendamento_fechamento_desfecho_check CHECK ((desfecho = ANY (ARRAY['compareceu'::text, 'faltou'::text, 'cancelou'::text, 'remarcou'::text]))),
  constraint agendamento_fechamento_origem_check CHECK ((origem = ANY (ARRAY['equipe'::text, 'paciente'::text, 'klingo'::text]))),
  constraint agendamento_fechamento_remarcacao_check CHECK ((remarcacao = ANY (ARRAY['pendente'::text, 'pedida'::text, 'aceita'::text, 'recusada'::text, 'feita'::text]))),
  constraint agendamento_fechamento_pkey PRIMARY KEY (id),
  constraint agendamento_fechamento_chave_key UNIQUE (chave)
);
comment on table public.agendamento_fechamento is 'Desfecho de cada exame marcado pelo chat. Sem linha aqui, a marcação está EM ABERTO. remarcacao acompanha a falta: pendente > pedida (pergunta enviada) > aceita (paciente está remarcando) > feita, ou recusada.';
CREATE INDEX agendamento_fechamento_conversa ON public.agendamento_fechamento USING btree (conversa_id);
alter table public.agendamento_fechamento enable row level security;
create policy agendamento_fechamento_select on public.agendamento_fechamento as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a authenticated: SELECT

create table public.agendamento_reconhecer_estado (
  id boolean default true not null,
  iniciou_em timestamp with time zone,
  terminou_em timestamp with time zone,
  proximo_em timestamp with time zone,
  falhas integer default 0 not null,
  erro text,
  constraint agendamento_reconhecer_estado_id_check CHECK (id),
  constraint agendamento_reconhecer_estado_pkey PRIMARY KEY (id)
);
comment on table public.agendamento_reconhecer_estado is 'Controle da leitura do Klingo que reconhece agendamentos: uma por vez, nova tentativa após erro. Sem dado de paciente.';
alter table public.agendamento_reconhecer_estado enable row level security;

create table public.agentes (
  id uuid not null,
  nome text not null,
  email text,
  papel text default 'atendente'::text not null,
  ativo boolean default false not null,
  criado_em timestamp with time zone default now() not null,
  visto_em timestamp with time zone,
  pedido_em timestamp with time zone,
  constraint agentes_papel_check CHECK ((papel = ANY (ARRAY['admin'::text, 'atendente'::text, 'marketing'::text]))),
  constraint agentes_pkey PRIMARY KEY (id)
);
comment on table public.agentes is 'Equipe com acesso ao painel. O primeiro usuário cadastrado vira admin ativo; os demais entram inativos até o admin liberar.';
alter table public.agentes enable row level security;
create policy agentes_delete on public.agentes as permissive for delete to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
create policy agentes_select on public.agentes as permissive for select to authenticated
  using (((id = ( SELECT auth.uid() AS uid)) OR (( SELECT papel_atual() AS papel_atual) IS NOT NULL)));
create policy agentes_update on public.agentes as permissive for update to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text))
  with check ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a authenticated: DELETE,SELECT

create table public.alerta_preco (
  id bigint generated always as identity not null,
  conversa_id uuid not null,
  mensagem_id bigint,
  agente_id uuid,
  valor_informado numeric(12,2) not null,
  tipo text not null,
  referencia jsonb not null,
  criado_em timestamp with time zone default now() not null,
  conferido_em timestamp with time zone,
  conferido_por uuid,
  constraint alerta_preco_tipo_check CHECK ((tipo = ANY (ARRAY['abaixo'::text, 'acima'::text]))),
  constraint alerta_preco_pkey PRIMARY KEY (id)
);
comment on table public.alerta_preco is 'Valor que o atendente informou no chat e que ficou fora (10% ou mais) do valor de referência do catálogo. Só administrador e atendente leem; o paciente nunca vê. Sem dado do paciente além da conversa.';
CREATE INDEX alerta_preco_aberto ON public.alerta_preco USING btree (conversa_id) WHERE (conferido_em IS NULL);
alter table public.alerta_preco enable row level security;
create policy alerta_preco_select on public.alerta_preco as permissive for select to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.assinatura_tentativas (
  id bigint generated always as identity not null,
  atendimento_id uuid not null,
  numero smallint not null,
  score_similaridade numeric(5,4) not null,
  ip_origem text,
  user_agent text,
  created_at timestamp with time zone default now() not null,
  constraint assinatura_tentativas_numero_check CHECK (((numero >= 1) AND (numero <= 3))),
  constraint assinatura_tentativas_pkey PRIMARY KEY (id),
  constraint assinatura_tentativas_atendimento_id_numero_key UNIQUE (atendimento_id, numero)
);
comment on table public.assinatura_tentativas is 'Tentativas reprovadas (score abaixo de 0,30). Imutável. O score nunca é devolvido ao paciente.';
alter table public.assinatura_tentativas enable row level security;
create policy assinatura_tentativas_admin on public.assinatura_tentativas as permissive for select to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a authenticated: SELECT

create table public.atendimento_tipo (
  chave text not null,
  instrucao text not null,
  constraint atendimento_tipo_chave_check CHECK ((chave = ANY (ARRAY['proprio'::text, 'filho'::text]))),
  constraint atendimento_tipo_pkey PRIMARY KEY (chave)
);
comment on table public.atendimento_tipo is 'Instrução da IA conforme quem será atendido (próprio ou filho). Vai em ia_contexto().inicio.instrucao_paciente. Sem policy: só funções security definer.';
alter table public.atendimento_tipo enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.atendimentos (
  id uuid default gen_random_uuid() not null,
  paciente_id uuid not null,
  email_informado text not null,
  status text default 'aguardando'::text not null,
  documento_texto text,
  documento_hash text,
  tentativas_falhas smallint default 0 not null,
  bloqueado_em timestamp with time zone,
  links_enviados smallint default 0 not null,
  created_at timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  constraint atendimentos_assinatura_completa CHECK (((status <> 'assinatura_pendente'::text) OR ((documento_texto IS NOT NULL) AND (documento_hash IS NOT NULL)))),
  constraint atendimentos_bloqueio_coerente CHECK (((bloqueado_em IS NULL) OR ((status = 'assinatura_pendente'::text) AND (tentativas_falhas = 3)))),
  constraint atendimentos_documento_hash_check CHECK ((documento_hash ~ '^[0-9a-f]{64}$'::text)),
  constraint atendimentos_documento_texto_check CHECK (((char_length(documento_texto) >= 20) AND (char_length(documento_texto) <= 20000))),
  constraint atendimentos_email_informado_check CHECK (((char_length(email_informado) <= 200) AND (email_informado ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'::text))),
  constraint atendimentos_links_enviados_check CHECK (((links_enviados >= 0) AND (links_enviados <= 10))),
  constraint atendimentos_status_check CHECK ((status = ANY (ARRAY['aguardando'::text, 'assinatura_pendente'::text, 'em_atendimento'::text, 'concluido'::text]))),
  constraint atendimentos_tentativas_falhas_check CHECK (((tentativas_falhas >= 0) AND (tentativas_falhas <= 3))),
  constraint atendimentos_pkey PRIMARY KEY (id)
);
comment on table public.atendimentos is 'Fila da recepção. Uma linha por visita. Escrita só por funções fila_* (equipe) e assinatura_* (n8n com segredo). O paciente lê só a própria linha, pelo token do link.';
CREATE INDEX atendimentos_fila_idx ON public.atendimentos USING btree (created_at, id) WHERE (status = 'aguardando'::text);
CREATE UNIQUE INDEX atendimentos_um_aberto_por_paciente ON public.atendimentos USING btree (paciente_id) WHERE (status <> 'concluido'::text);
alter table public.atendimentos enable row level security;
create policy atendimentos_equipe_select on public.atendimentos as permissive for select to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
create policy atendimentos_paciente_token on public.atendimentos as permissive for select to anon
  using ((id = ( SELECT fila_atendimento_do_cabecalho() AS fila_atendimento_do_cabecalho)));
-- concessão a authenticated: SELECT

create table public.autoencerramento_execucao (
  id bigint generated always as identity not null,
  em timestamp with time zone default now() not null,
  modo text not null,
  elegiveis integer not null,
  fechadas integer not null,
  constraint autoencerramento_execucao_pkey PRIMARY KEY (id)
);
alter table public.autoencerramento_execucao enable row level security;
create policy autoencerramento_execucao_select on public.autoencerramento_execucao as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.autoencerramento_fechada (
  conversa_id uuid not null,
  fechada_em timestamp with time zone default now() not null,
  aguarda_paciente_desde timestamp with time zone,
  constraint autoencerramento_fechada_pkey PRIMARY KEY (conversa_id, fechada_em)
);
alter table public.autoencerramento_fechada enable row level security;
create policy autoencerramento_fechada_select on public.autoencerramento_fechada as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.avaliacao_atendimento (
  id bigint generated always as identity not null,
  conversa_id uuid not null,
  encerrada_em timestamp with time zone not null,
  nota_atendimento smallint not null,
  nota_site smallint not null,
  canal text not null,
  criado_em timestamp with time zone default now() not null,
  constraint avaliacao_atendimento_canal_check CHECK ((canal = ANY (ARRAY['WhatsApp'::text, 'Instagram'::text, 'Google'::text]))),
  constraint avaliacao_atendimento_nota_atendimento_check CHECK (((nota_atendimento >= 0) AND (nota_atendimento <= 10))),
  constraint avaliacao_atendimento_nota_site_check CHECK (((nota_site >= 0) AND (nota_site <= 10))),
  constraint avaliacao_atendimento_pkey PRIMARY KEY (id),
  constraint avaliacao_atendimento_conversa_id_encerrada_em_key UNIQUE (conversa_id, encerrada_em)
);
comment on table public.avaliacao_atendimento is 'Uma avaliação voluntária por fechamento. Sem nome, telefone ou texto livre. A referência do fechamento é conversas.encerrada_em.';
alter table public.avaliacao_atendimento enable row level security;
create policy avaliacao_atendimento_select on public.avaliacao_atendimento as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.catalogo_agenda (
  id bigint generated always as identity not null,
  unidade text,
  local text,
  profissional_id integer,
  profissional text,
  especialidade text,
  procedimento_id integer,
  procedimento text,
  dia_num integer,
  dia text,
  hora_ini text,
  hora_fim text,
  duracao_min integer,
  operadoras text,
  tele boolean,
  vagas_extras integer,
  vig_ini date,
  vig_fim date,
  hash text,
  constraint catalogo_agenda_pkey PRIMARY KEY (id)
);
comment on table public.catalogo_agenda is 'Cópia do relatório Klingo 13984 (agenda por profissional: grade semanal, não é horário livre).';
CREATE INDEX catalogo_agenda_hash ON public.catalogo_agenda USING btree (hash);
CREATE INDEX catalogo_agenda_proc ON public.catalogo_agenda USING btree (procedimento_id);
alter table public.catalogo_agenda enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.catalogo_foto (
  id bigint generated always as identity not null,
  tipo text not null,
  motivo text not null,
  referencia boolean default false not null,
  tirada_em timestamp with time zone default now() not null,
  linhas integer not null,
  dados jsonb not null,
  constraint catalogo_foto_tipo_check CHECK ((tipo = ANY (ARRAY['procedimento'::text, 'agenda'::text, 'plano'::text]))),
  constraint catalogo_foto_pkey PRIMARY KEY (id)
);
comment on table public.catalogo_foto is 'Cópia integral do catálogo em um momento. referencia=true: foto de 29/10/2026, antes da limpeza do cadastro no Klingo; nunca apagar.';
alter table public.catalogo_foto enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.catalogo_meta (
  tipo text not null,
  linhas integer not null,
  atualizado_em timestamp with time zone default now() not null,
  constraint catalogo_meta_pkey PRIMARY KEY (tipo)
);
alter table public.catalogo_meta enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.catalogo_mudanca (
  id bigint generated always as identity not null,
  lote uuid not null,
  detectada_em timestamp with time zone default now() not null,
  tipo text not null,
  evento text not null,
  chave text not null,
  descricao text,
  campo text,
  antes text,
  depois text,
  constraint catalogo_mudanca_evento_check CHECK ((evento = ANY (ARRAY['novo'::text, 'alterado'::text, 'removido'::text, 'reativado'::text, 'bloqueado'::text]))),
  constraint catalogo_mudanca_tipo_check CHECK ((tipo = ANY (ARRAY['procedimento'::text, 'plano'::text, 'agenda'::text, 'preco'::text]))),
  constraint catalogo_mudanca_pkey PRIMARY KEY (id)
);
comment on table public.catalogo_mudanca is 'O que mudou no catálogo a cada sincronização (novo, alterado, removido, reativado). Sem dado de paciente.';
CREATE INDEX catalogo_mudanca_data ON public.catalogo_mudanca USING btree (detectada_em DESC);
CREATE INDEX catalogo_mudanca_tipo ON public.catalogo_mudanca USING btree (tipo, evento);
alter table public.catalogo_mudanca enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.catalogo_plano (
  id bigint generated always as identity not null,
  operadora text,
  plano text,
  produto text,
  busca tsvector not null,
  ativo boolean default true not null,
  visto_em timestamp with time zone default now() not null,
  removido_em timestamp with time zone,
  constraint catalogo_plano_pkey PRIMARY KEY (id)
);
comment on table public.catalogo_plano is 'Cópia do relatório Klingo 12301 (operadoras e planos).';
CREATE INDEX catalogo_plano_busca ON public.catalogo_plano USING gin (busca);
CREATE UNIQUE INDEX catalogo_plano_chave ON public.catalogo_plano USING btree (operadora, plano, COALESCE(produto, ''::text));
alter table public.catalogo_plano enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.catalogo_preco (
  id bigint generated always as identity not null,
  chave text not null,
  fonte text not null,
  operadora_id integer,
  operadora text,
  tabela_id integer,
  tabela text,
  procedimento_id integer not null,
  procedimento text,
  item_codigo text,
  item_descricao text,
  valor numeric(12,2),
  moeda text,
  amostras integer,
  valor_min numeric(12,2),
  valor_max numeric(12,2),
  ultima_marcacao date,
  confianca text,
  status text default 'ativo'::text not null,
  vigente_desde timestamp with time zone default now() not null,
  visto_em timestamp with time zone default now() not null,
  removido_em timestamp with time zone,
  constraint catalogo_preco_confianca_check CHECK ((confianca = ANY (ARRAY['alta'::text, 'media'::text, 'baixa'::text]))),
  constraint catalogo_preco_fonte_check CHECK ((fonte = ANY (ARRAY['convenio'::text, 'particular'::text]))),
  constraint catalogo_preco_status_check CHECK ((status = ANY (ARRAY['ativo'::text, 'removido'::text]))),
  constraint catalogo_preco_pkey PRIMARY KEY (id),
  constraint catalogo_preco_chave_key UNIQUE (chave)
);
comment on table public.catalogo_preco is 'Preço por procedimento. convenio: relatório Klingo 13983 (por operadora e tabela). particular: valor das marcações recentes do relatório 13825, só agregado (sem dado de paciente). A IA só usa status ativo; valor é referência, o atendente confirma.';
CREATE INDEX catalogo_preco_operadora ON public.catalogo_preco USING btree (operadora_id) WHERE (fonte = 'convenio'::text);
CREATE INDEX catalogo_preco_proc ON public.catalogo_preco USING btree (procedimento_id) WHERE (status = 'ativo'::text);
alter table public.catalogo_preco enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.catalogo_preco_revisao (
  procedimento_id integer not null,
  opn text not null,
  operadora text not null,
  ligado boolean default false not null,
  valor numeric(12,2) not null,
  nota text,
  revisado_por uuid,
  revisado_em timestamp with time zone default now() not null,
  referencia numeric(12,2),
  constraint catalogo_preco_revisao_nota_check CHECK (((nota IS NULL) OR (length(nota) <= 200))),
  constraint catalogo_preco_revisao_valor_check CHECK (((valor >= (5)::numeric) AND (valor < (100000)::numeric))),
  constraint catalogo_preco_revisao_pkey PRIMARY KEY (procedimento_id, opn)
);
comment on table public.catalogo_preco_revisao is 'Preço revisado por uma pessoa. ligado = o chat informa esta previsão ao paciente. Sem acesso direto: só as funções catalogo_cardapio, catalogo_preco_revisar e preco_previsao_chat leem ou escrevem.';
alter table public.catalogo_preco_revisao enable row level security;

create table public.catalogo_preco_revisao_log (
  id bigint generated always as identity not null,
  procedimento_id integer not null,
  opn text not null,
  operadora text not null,
  ligado_antes boolean,
  ligado_depois boolean not null,
  valor_antes numeric(12,2),
  valor_depois numeric(12,2) not null,
  nota text,
  por uuid,
  criado_em timestamp with time zone default now() not null,
  constraint catalogo_preco_revisao_log_pkey PRIMARY KEY (id)
);
alter table public.catalogo_preco_revisao_log enable row level security;

create table public.catalogo_procedimento (
  id integer not null,
  nome text not null,
  tuss text,
  especialidade text,
  classe text,
  idade_min integer,
  idade_max integer,
  sexo text,
  preparo text,
  busca tsvector not null,
  ativo boolean default true not null,
  visto_em timestamp with time zone default now() not null,
  removido_em timestamp with time zone,
  demanda_90d integer,
  modalidade text generated always as (modalidade_de(classe)) stored,
  constraint catalogo_procedimento_pkey PRIMARY KEY (id)
);
comment on table public.catalogo_procedimento is 'Cópia do relatório Klingo 13981 (procedimentos e preparo). Sem dado de paciente. Sem policy: só funções security definer e service_role acessam.';
CREATE INDEX catalogo_procedimento_busca ON public.catalogo_procedimento USING gin (busca);
CREATE INDEX catalogo_procedimento_modalidade ON public.catalogo_procedimento USING btree (modalidade) WHERE ativo;
alter table public.catalogo_procedimento enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.catalogo_regiao (
  codigo text not null,
  nome text not null,
  grupo text not null,
  tem_lado boolean default false not null,
  ordem integer not null,
  padrao text not null,
  constraint catalogo_regiao_pkey PRIMARY KEY (codigo)
);
comment on table public.catalogo_regiao is 'Partes do corpo do mapa anatômico do chat. padrao = expressão regular aplicada ao nome do exame (sem acento, maiúsculas) para saber quais exames atendem a região. tem_lado = tem lado direito/esquerdo.';
alter table public.catalogo_regiao enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.chat_cache (
  chave text not null,
  valor jsonb not null,
  calculado_em timestamp with time zone default now() not null,
  constraint chat_cache_pkey PRIMARY KEY (chave)
);
comment on table public.chat_cache is 'Respostas prontas do chat que são iguais para todo paciente (hoje: o mapa do corpo). Sem dado pessoal. Só as funções leem.';
alter table public.chat_cache enable row level security;

create table public.chat_push_inscricao (
  id bigint generated always as identity not null,
  conversa_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  criado_em timestamp with time zone default now() not null,
  constraint chat_push_inscricao_endpoint_check CHECK ((char_length(endpoint) <= 1000)),
  constraint chat_push_inscricao_pkey PRIMARY KEY (id),
  constraint chat_push_inscricao_endpoint_key UNIQUE (endpoint)
);
comment on table public.chat_push_inscricao is 'Aparelhos do cliente que aceitaram notificação no chat. Só as funções chat_push_* e a Edge Function chat-avisar (service_role) acessam.';
CREATE INDEX chat_push_inscricao_conversa_idx ON public.chat_push_inscricao USING btree (conversa_id);
alter table public.chat_push_inscricao enable row level security;

create table public.config (
  chave text not null,
  valor text default ''::text not null,
  constraint config_pkey PRIMARY KEY (chave)
);
alter table public.config enable row level security;
create policy config_select on public.config as permissive for select to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
create policy config_update on public.config as permissive for update to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text))
  with check ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a authenticated: SELECT

create table public.consulta_config (
  procedimento_id integer not null,
  oculta boolean default false not null,
  rotulo text,
  atualizado_em timestamp with time zone default now() not null,
  atualizado_por uuid,
  constraint consulta_config_pkey PRIMARY KEY (procedimento_id)
);
comment on table public.consulta_config is 'Ajustes por consulta: esconder do chat e/ou renomear. Sem policy: só as funções security definer acessam.';
alter table public.consulta_config enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.conta_paciente_evento (
  id bigint generated always as identity not null,
  tipo text not null,
  tinha_cadastro boolean default false not null,
  conversas integer default 0 not null,
  criado_em timestamp with time zone default now() not null,
  constraint conta_paciente_evento_tipo_check CHECK ((tipo = ANY (ARRAY['copia'::text, 'exclusao'::text]))),
  constraint conta_paciente_evento_pkey PRIMARY KEY (id)
);
comment on table public.conta_paciente_evento is 'Pedidos dos pacientes pela tela "Meus dados" (cópia dos dados e exclusão da conta). Sem dado pessoal: só tipo, data e contagens.';
alter table public.conta_paciente_evento enable row level security;
create policy conta_paciente_evento_select on public.conta_paciente_evento as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a authenticated: SELECT

create table public.contas_paciente (
  id uuid not null,
  email text,
  paciente_id uuid,
  criado_em timestamp with time zone default now() not null,
  ultimo_acesso_em timestamp with time zone,
  nome text,
  telefone text,
  aceitou_lgpd_em timestamp with time zone,
  vinculo_tentativas integer default 0 not null,
  vinculo_ultima_em timestamp with time zone,
  vinculado_em timestamp with time zone,
  vinculo_metodo text,
  senha_provisoria boolean default false not null,
  identidade_conferida_em timestamp with time zone,
  constraint contas_paciente_pkey PRIMARY KEY (id)
);
comment on table public.contas_paciente is 'Conta de login do paciente (Supabase Auth). Criada pelo gatilho novo_usuario. paciente_id é preenchido quando a PRÓPRIA conversa logada cria o cadastro (ver login-paciente.sql) ou pela equipe depois de validar a identidade. Cadastro que já existia (e-mail digitado antes, sem verificação) nunca é vinculado sozinho.';
CREATE INDEX contas_paciente_paciente ON public.contas_paciente USING btree (paciente_id);
alter table public.contas_paciente enable row level security;
create policy contas_paciente_select on public.contas_paciente as permissive for select to public
  using (((id = ( SELECT auth.uid() AS uid)) OR (( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text]))));
-- concessão a authenticated: SELECT

create table public.contatos (
  id uuid default gen_random_uuid() not null,
  nome text not null,
  telefone text not null,
  email text,
  origem text,
  tags text[] default '{}'::text[] not null,
  observacoes text,
  aceitou_lgpd_em timestamp with time zone,
  criado_em timestamp with time zone default now() not null,
  ultimo_contato_em timestamp with time zone default now() not null,
  teste boolean default false not null,
  teste_motivo text,
  constraint contatos_email_check CHECK (((email IS NULL) OR (char_length(email) <= 200))),
  constraint contatos_nome_check CHECK (((char_length(nome) >= 2) AND (char_length(nome) <= 120))),
  constraint contatos_telefone_check CHECK (((char_length(telefone) >= 10) AND (char_length(telefone) <= 11))),
  constraint contatos_pkey PRIMARY KEY (id)
);
comment on table public.contatos is 'Leads/clientes que iniciaram conversa. Telefone guardado só com dígitos (DDD + número). Criado apenas via chat_iniciar().';
CREATE UNIQUE INDEX contatos_telefone_key ON public.contatos USING btree (telefone);
alter table public.contatos enable row level security;
create policy contatos_delete on public.contatos as permissive for delete to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
create policy contatos_select on public.contatos as permissive for select to authenticated
  using ((( SELECT papel_atual() AS papel_atual) IS NOT NULL));
create policy contatos_update on public.contatos as permissive for update to authenticated
  using ((( SELECT papel_atual() AS papel_atual) IS NOT NULL))
  with check ((( SELECT papel_atual() AS papel_atual) IS NOT NULL));
-- concessão a authenticated: DELETE,SELECT

create table public.convenio_config (
  operadora text not null,
  ativo boolean default true not null,
  mensagem_inativo text,
  aviso text,
  um_por_vez boolean default false not null,
  msg_varios text,
  motivo text,
  atualizado_em timestamp with time zone default now() not null,
  atualizado_por uuid,
  suspenso_em timestamp with time zone,
  suspenso_ate timestamp with time zone,
  suspenso_por uuid,
  suspenso_motivo text,
  revisao_avisada_em timestamp with time zone,
  constraint convenio_config_pkey PRIMARY KEY (operadora)
);
alter table public.convenio_config enable row level security;

create table public.convenio_evento (
  id bigint generated always as identity not null,
  criado_em timestamp with time zone default now() not null,
  operadora text not null,
  tipo text not null,
  descricao text not null,
  antes text,
  depois text,
  variacao_pct numeric,
  relevante boolean default false not null,
  origem text default 'catalogo'::text not null,
  visto_em timestamp with time zone,
  visto_por uuid,
  constraint convenio_evento_pkey PRIMARY KEY (id)
);
CREATE INDEX convenio_evento_novos_idx ON public.convenio_evento USING btree (criado_em DESC) WHERE (visto_em IS NULL);
CREATE INDEX convenio_evento_op_idx ON public.convenio_evento USING btree (operadora, criado_em DESC);
alter table public.convenio_evento enable row level security;

create table public.conversa_agendado_conferencia (
  conversa_id uuid not null,
  situacao text not null,
  fonte text,
  codigo text,
  exame_em timestamp with time zone,
  encerrada_em timestamp with time zone default now() not null,
  verificada_em timestamp with time zone,
  tentativas integer default 0 not null,
  aviso_texto text,
  avisada_em timestamp with time zone,
  push_em timestamp with time zone,
  constraint conversa_agendado_conferencia_situacao_check CHECK ((situacao = ANY (ARRAY['verificando'::text, 'confirmado'::text, 'problema'::text, 'concluido'::text]))),
  constraint conversa_agendado_conferencia_pkey PRIMARY KEY (conversa_id)
);
comment on table public.conversa_agendado_conferencia is 'Conferência, em segundo plano, das conversas que a equipe encerrou como Agendado. Sem dado de paciente.';
alter table public.conversa_agendado_conferencia enable row level security;
create policy conversa_agendado_conferencia_select on public.conversa_agendado_conferencia as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.conversa_anexo (
  id bigint generated always as identity not null,
  conversa_id uuid not null,
  tipo text default 'pedido_medico'::text not null,
  mime text not null,
  dados bytea not null,
  ocr_texto text,
  criado_em timestamp with time zone default now() not null,
  largura integer,
  altura integer,
  ocr_motor text,
  ocr_linhas jsonb,
  ia_leitura jsonb,
  ia_modelo text,
  ia_ms integer,
  ia_erro text,
  ia_em timestamp with time zone,
  escolha jsonb,
  escolha_em timestamp with time zone,
  gabarito jsonb,
  gabarito_por uuid,
  gabarito_em timestamp with time zone,
  klingo_conferido_em timestamp with time zone,
  klingo_conferido_por uuid,
  constraint conversa_anexo_pkey PRIMARY KEY (id)
);
comment on table public.conversa_anexo is 'Foto do pedido médico enviada pelo paciente. Sem policy: o chat grava por chat_anexo_enviar e a equipe lê por painel_anexo.';
CREATE INDEX conversa_anexo_conversa ON public.conversa_anexo USING btree (conversa_id);
alter table public.conversa_anexo enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.conversa_encerramento (
  id bigint generated always as identity not null,
  conversa_id uuid not null,
  encerrada_em timestamp with time zone not null,
  motivo text,
  origem text,
  por uuid,
  constraint conversa_encerramento_motivo_check CHECK (((motivo IS NULL) OR (motivo = ANY (ARRAY['agendado'::text, 'apenas_informacoes'::text, 'nao_respondido'::text, 'desistiu'::text, 'outro'::text, 'nova_conversa'::text])))),
  constraint conversa_encerramento_origem_check CHECK (((origem IS NULL) OR (origem = ANY (ARRAY['equipe'::text, 'sistema'::text, 'inatividade'::text, 'paciente'::text])))),
  constraint conversa_encerramento_pkey PRIMARY KEY (id),
  constraint conversa_encerramento_conversa_id_encerrada_em_key UNIQUE (conversa_id, encerrada_em)
);
comment on table public.conversa_encerramento is 'Um registro por fechamento (a conversa pode ser reaberta e fechada de novo). Sem nome, telefone ou texto de conversa.';
alter table public.conversa_encerramento enable row level security;
create policy conversa_encerramento_select on public.conversa_encerramento as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.conversa_evento (
  id bigint generated always as identity not null,
  conversa_id uuid not null,
  tipo text not null,
  em timestamp with time zone default now() not null,
  de_agente uuid,
  para_agente uuid,
  por uuid,
  motivo text,
  detalhe jsonb,
  constraint conversa_evento_pkey PRIMARY KEY (id)
);
comment on table public.conversa_evento is 'Linha do tempo única da conversa (criada, assumida, devolvida, transferida, primeiro_humano, encerrada, autoencerrada, reaberta, teste_marcado, teste_desmarcado). Sem texto de mensagem nem dado pessoal. Só gatilhos e funções do banco escrevem.';
CREATE INDEX conversa_evento_conversa ON public.conversa_evento USING btree (conversa_id, em);
CREATE INDEX conversa_evento_tipo_em ON public.conversa_evento USING btree (tipo, em);
alter table public.conversa_evento enable row level security;
create policy conversa_evento_select on public.conversa_evento as permissive for select to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a authenticated: REFERENCES,SELECT,TRIGGER,TRUNCATE

create table public.conversa_fluxo (
  conversa_id uuid not null,
  passo text,
  tentativas integer default 0 not null,
  dados jsonb default '{}'::jsonb not null,
  iniciado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  constraint conversa_fluxo_pkey PRIMARY KEY (conversa_id)
);
comment on table public.conversa_fluxo is 'Em que passo do roteiro cada conversa está e o que o motor já sabe (motivo, flags dos grupos de dados, notas para o atendente).';
alter table public.conversa_fluxo enable row level security;
create policy conversa_fluxo_select on public.conversa_fluxo as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.conversa_grupo (
  conversa_id uuid not null,
  grupo_id uuid not null,
  sinais text[] default '{}'::text[] not null,
  origem text default 'auto'::text not null,
  confirmado_por uuid,
  criado_em timestamp with time zone default now() not null,
  constraint conversa_grupo_origem_check CHECK ((origem = ANY (ARRAY['auto'::text, 'equipe'::text]))),
  constraint conversa_grupo_pkey PRIMARY KEY (conversa_id)
);
comment on table public.conversa_grupo is 'Conversas da mesma pessoa. Só uma ligação: nenhuma mensagem é movida ou apagada. origem = auto (3 informações batem) ou equipe (um atendente confirmou).';
CREATE INDEX conversa_grupo_grupo ON public.conversa_grupo USING btree (grupo_id);
alter table public.conversa_grupo enable row level security;
create policy conversa_grupo_select on public.conversa_grupo as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a authenticated: SELECT

create table public.conversa_grupo_recusa (
  a uuid not null,
  b uuid not null,
  por uuid,
  em timestamp with time zone default now() not null,
  constraint conversa_grupo_recusa_check CHECK ((a < b)),
  constraint conversa_grupo_recusa_pkey PRIMARY KEY (a, b)
);
comment on table public.conversa_grupo_recusa is 'Pares que a equipe disse que NÃO são a mesma pessoa. O agrupamento automático nunca junta esses pares.';
alter table public.conversa_grupo_recusa enable row level security;

create table public.conversa_segredo (
  conversa_id uuid not null,
  token text default replace(((gen_random_uuid())::text || (gen_random_uuid())::text), '-'::text, ''::text) not null,
  constraint conversa_segredo_pkey PRIMARY KEY (conversa_id),
  constraint conversa_segredo_token_key UNIQUE (token)
);
comment on table public.conversa_segredo is 'Token secreto de cada conversa (fica no navegador do cliente). Sem acesso direto: só as funções chat_* leem.';
alter table public.conversa_segredo enable row level security;

create table public.conversas (
  id uuid default gen_random_uuid() not null,
  contato_id uuid not null,
  status text default 'aguardando'::text not null,
  agente_id uuid,
  ultima_mensagem text,
  nao_lidas_agente integer default 0 not null,
  criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  encerrada_em timestamp with time zone,
  ia_ativa boolean default true not null,
  triagem_resumo text,
  triagem_urgencia text,
  alerta_agenda text,
  nome_informado text,
  email_informado text,
  unidade_inicial text,
  medico_preferido text,
  paciente_tipo text default 'proprio'::text not null,
  paciente_nome text,
  irmaos jsonb default '[]'::jsonb not null,
  irmaos_modo text,
  irmao_de uuid,
  motor text default 'ia'::text not null,
  conta_id uuid,
  cliente_aguarda_desde timestamp with time zone,
  espera_alerta_em timestamp with time zone,
  espera_aviso_paciente_em timestamp with time zone,
  motivo_encerramento text,
  encerrada_por uuid,
  encerramento_origem text,
  aguarda_paciente_desde timestamp with time zone,
  teste boolean default false not null,
  teste_motivo text,
  teste_manual boolean default false not null,
  primeiro_humano_em timestamp with time zone,
  previsao_aceita_em timestamp with time zone,
  reentrada_de uuid,
  reentrada_motivo text,
  reentrada_motivo_auto text,
  reentrada_texto_informado boolean,
  unidade_responsavel text,
  push_silenciado_em timestamp with time zone,
  chamar_zap_em timestamp with time zone,
  chamar_zap_feito_em timestamp with time zone,
  chamar_zap_feito_por uuid,
  constraint conversas_encerramento_origem_ck CHECK (((encerramento_origem IS NULL) OR (encerramento_origem = ANY (ARRAY['equipe'::text, 'sistema'::text, 'inatividade'::text, 'paciente'::text])))),
  constraint conversas_irmaos_modo_check CHECK ((irmaos_modo = ANY (ARRAY['um_de_cada_vez'::text, 'juntos'::text]))),
  constraint conversas_motivo_encerramento_ck CHECK (((motivo_encerramento IS NULL) OR (motivo_encerramento = ANY (ARRAY['agendado'::text, 'apenas_informacoes'::text, 'nao_respondido'::text, 'desistiu'::text, 'outro'::text, 'nova_conversa'::text])))),
  constraint conversas_motor_check CHECK ((motor = ANY (ARRAY['ia'::text, 'fluxo'::text]))),
  constraint conversas_paciente_tipo_check CHECK ((paciente_tipo = ANY (ARRAY['proprio'::text, 'filho'::text]))),
  constraint conversas_reentrada_motivo_ck CHECK (((reentrada_motivo IS NULL) OR (reentrada_motivo = ANY (ARRAY['sem_retorno'::text, 'outro_assunto'::text])))),
  constraint conversas_status_check CHECK ((status = ANY (ARRAY['aguardando'::text, 'em_atendimento'::text, 'encerrada'::text]))),
  constraint conversas_triagem_urgencia_check CHECK ((triagem_urgencia = ANY (ARRAY['baixa'::text, 'media'::text, 'alta'::text]))),
  constraint conversas_pkey PRIMARY KEY (id)
);
CREATE INDEX conversas_agente_idx ON public.conversas USING btree (agente_id);
CREATE INDEX conversas_conta_idx ON public.conversas USING btree (conta_id) WHERE (conta_id IS NOT NULL);
CREATE INDEX conversas_contato_idx ON public.conversas USING btree (contato_id);
CREATE INDEX conversas_reentrada_de_idx ON public.conversas USING btree (reentrada_de) WHERE (reentrada_de IS NOT NULL);
CREATE INDEX conversas_status_idx ON public.conversas USING btree (status, atualizado_em DESC);
alter table public.conversas enable row level security;
create policy conversas_select on public.conversas as permissive for select to authenticated
  using (((( SELECT papel_atual() AS papel_atual) IS NOT NULL) AND ((NOT ( SELECT permissao_restringe() AS permissao_restringe)) OR pode_ver_conversa(id))));
create policy conversas_update on public.conversas as permissive for update to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])))
  with check ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a authenticated: SELECT

create table public.despedida_versao (
  id bigint generated always as identity not null,
  texto text,
  mime text,
  dados bytea,
  criado_em timestamp with time zone default now() not null,
  criado_por uuid,
  constraint despedida_versao_check CHECK (((mime IS NULL) = (dados IS NULL))),
  constraint despedida_versao_check1 CHECK (((texto IS NOT NULL) OR (dados IS NOT NULL))),
  constraint despedida_versao_mime_check CHECK (((mime IS NULL) OR (mime = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text])))),
  constraint despedida_versao_texto_check CHECK (((texto IS NULL) OR ((char_length(texto) >= 1) AND (char_length(texto) <= 600)))),
  constraint despedida_versao_pkey PRIMARY KEY (id)
);
comment on table public.despedida_versao is 'Cada salvamento da despedida é uma versão nova; as antigas nunca mudam (o histórico das conversas aponta para a versão entregue).';
alter table public.despedida_versao enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.equipe_convites (
  email text not null,
  papel text default 'atendente'::text not null,
  criado_por uuid,
  criado_em timestamp with time zone default now() not null,
  usado_em timestamp with time zone,
  constraint equipe_convites_email_check CHECK (((email = lower(btrim(email))) AND (email <> ''::text))),
  constraint equipe_convites_papel_check CHECK ((papel = ANY (ARRAY['admin'::text, 'atendente'::text, 'marketing'::text]))),
  constraint equipe_convites_pkey PRIMARY KEY (email)
);
comment on table public.equipe_convites is 'E-mails que podem virar equipe ao se cadastrar. Uso único (usado_em). Criado por equipe_convidar (administrador).';
alter table public.equipe_convites enable row level security;

create table public.equipe_notificacao (
  id bigint generated always as identity not null,
  agente_id uuid,
  tipo text not null,
  conversa_id uuid,
  detalhe jsonb default '{}'::jsonb not null,
  criado_em timestamp with time zone default now() not null,
  lida_em timestamp with time zone,
  constraint equipe_notificacao_pkey PRIMARY KEY (id)
);
CREATE INDEX equipe_notificacao_destino_idx ON public.equipe_notificacao USING btree (agente_id, criado_em DESC) WHERE (lida_em IS NULL);
alter table public.equipe_notificacao enable row level security;
create policy equipe_notificacao_select on public.equipe_notificacao as permissive for select to public
  using (((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])) AND ((agente_id = ( SELECT auth.uid() AS uid)) OR ((agente_id IS NULL) AND (( SELECT papel_atual() AS papel_atual) = 'admin'::text)))));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.fila_aviso (
  id bigint generated always as identity not null,
  fila_id uuid not null,
  conta_id uuid,
  tipo text not null,
  titulo text not null,
  corpo text not null,
  criado_em timestamp with time zone default now() not null,
  enviado_em timestamp with time zone,
  constraint fila_aviso_tipo_check CHECK ((tipo = ANY (ARRAY['chegada'::text, 'perto'::text, 'vez'::text]))),
  constraint fila_aviso_pkey PRIMARY KEY (id),
  constraint fila_aviso_fila_id_tipo_key UNIQUE (fila_id, tipo)
);
comment on table public.fila_aviso is 'Caixa de saída dos avisos. A Edge Function fila-avisar envia os que têm enviado_em nulo. Sem acesso do navegador.';
alter table public.fila_aviso enable row level security;

create table public.fila_chegada (
  id uuid default gen_random_uuid() not null,
  conta_id uuid,
  paciente_id uuid,
  nome text not null,
  senha integer not null,
  status text default 'aguardando'::text not null,
  origem text default 'paciente'::text not null,
  chegou_em timestamp with time zone default now() not null,
  chamado_em timestamp with time zone,
  concluido_em timestamp with time zone,
  email text,
  telefone text,
  pede_senha boolean default false not null,
  ticket uuid default gen_random_uuid() not null,
  constraint fila_chegada_nome_check CHECK (((char_length(btrim(nome)) >= 1) AND (char_length(btrim(nome)) <= 120))),
  constraint fila_chegada_origem_check CHECK ((origem = ANY (ARRAY['paciente'::text, 'recepcao'::text]))),
  constraint fila_chegada_status_check CHECK ((status = ANY (ARRAY['aguardando'::text, 'chamado'::text, 'atendido'::text, 'cancelado'::text]))),
  constraint fila_chegada_pkey PRIMARY KEY (id)
);
comment on table public.fila_chegada is 'Fila de chegada na clínica (uma linha por visita). Escrita só pelas funções fila_*. O paciente nunca lê a tabela: vê só a própria posição por fila_minha_vez(). A equipe (admin/atendente) lê.';
CREATE INDEX fila_chegada_aberta_idx ON public.fila_chegada USING btree (chegou_em, id) WHERE (status = 'aguardando'::text);
CREATE UNIQUE INDEX fila_chegada_ticket ON public.fila_chegada USING btree (ticket);
CREATE UNIQUE INDEX fila_chegada_uma_aberta_por_conta ON public.fila_chegada USING btree (conta_id) WHERE ((status = ANY (ARRAY['aguardando'::text, 'chamado'::text])) AND (conta_id IS NOT NULL));
alter table public.fila_chegada enable row level security;
create policy fila_chegada_equipe on public.fila_chegada as permissive for select to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a authenticated: SELECT

create table public.fluxo_evento (
  id bigint generated always as identity not null,
  conversa_id uuid,
  passo text,
  entrada text,
  entendido boolean,
  ms numeric,
  ms_cliente integer,
  criado_em timestamp with time zone default now() not null,
  constraint fluxo_evento_pkey PRIMARY KEY (id)
);
comment on table public.fluxo_evento is 'Uma linha por mensagem tratada pelo motor: passo, tipo de entrada, se entendeu e o tempo (servidor e o que o paciente viu).';
CREATE INDEX fluxo_evento_criado ON public.fluxo_evento USING btree (criado_em);
alter table public.fluxo_evento enable row level security;
create policy fluxo_evento_select on public.fluxo_evento as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.fluxo_texto (
  chave text not null,
  texto text not null,
  descricao text,
  constraint fluxo_texto_pkey PRIMARY KEY (chave)
);
comment on table public.fluxo_texto is 'Textos do motor, editáveis pela equipe. {nome}, {paciente}, {quem}, {de_quem}, {para_quem} e outros são trocados na hora.';
alter table public.fluxo_texto enable row level security;
create policy fluxo_texto_select on public.fluxo_texto as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
create policy fluxo_texto_update on public.fluxo_texto as permissive for update to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text))
  with check ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.ia_evento (
  id bigint generated always as identity not null,
  pre_agendamento_id uuid,
  conversa_id uuid,
  tipo text not null,
  de text,
  para text,
  por text default 'sistema'::text not null,
  agente_id uuid,
  detalhe text,
  contexto jsonb default '{}'::jsonb not null,
  criado_em timestamp with time zone default now() not null,
  constraint ia_evento_por_check CHECK ((por = ANY (ARRAY['atendente'::text, 'sistema'::text]))),
  constraint ia_evento_tipo_check CHECK ((tipo = ANY (ARRAY['criado'::text, 'status'::text, 'conferencia'::text]))),
  constraint ia_evento_pkey PRIMARY KEY (id)
);
comment on table public.ia_evento is 'Linha do tempo dos pré-agendamentos (criado, status, conferência) para medir onde a IA erra. Sem dado de paciente. Só admin lê (pelas funções ia_*).';
CREATE INDEX ia_evento_criado_idx ON public.ia_evento USING btree (criado_em DESC);
CREATE INDEX ia_evento_pre_idx ON public.ia_evento USING btree (pre_agendamento_id, criado_em);
alter table public.ia_evento enable row level security;
create policy ia_evento_select on public.ia_evento as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.incidente_chat (
  id bigint generated always as identity not null,
  codigo text not null,
  tipo text not null,
  conversa_id uuid,
  passo text,
  versao text,
  detalhe jsonb default '{}'::jsonb not null,
  criado_em timestamp with time zone default now() not null,
  constraint incidente_chat_pkey PRIMARY KEY (id),
  constraint incidente_chat_codigo_key UNIQUE (codigo)
);
comment on table public.incidente_chat is 'Problemas vistos pela Sentinela do chat. O paciente recebe o código (CSI-AAMMDD-HHMM-TIPO-XXXX); a equipe acha o caso por ele. Sem texto de mensagem nem dado pessoal.';
CREATE INDEX incidente_chat_conversa ON public.incidente_chat USING btree (conversa_id);
CREATE INDEX incidente_chat_criado ON public.incidente_chat USING btree (criado_em DESC);
alter table public.incidente_chat enable row level security;
create policy incidente_chat_select on public.incidente_chat as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.ind_conclusao_dia (
  dia date not null,
  ordem integer not null,
  pessoa text,
  teste boolean not null,
  unidades text[] default '{}'::text[] not null,
  origem text,
  motivo text,
  cruzou boolean not null,
  mais24 boolean not null,
  reencerrada boolean not null,
  constraint ind_conclusao_dia_pkey PRIMARY KEY (dia, ordem)
);
alter table public.ind_conclusao_dia enable row level security;

create table public.ind_fechamento (
  dia date not null,
  fechado_em timestamp with time zone default now() not null,
  regra_versao integer default 1 not null,
  resumo jsonb,
  constraint ind_fechamento_pkey PRIMARY KEY (dia)
);
comment on table public.ind_fechamento is 'Dias já fechados dos indicadores. Fechado = congelado: ind_pessoa_dia, ind_conclusao_dia e ind_semhumano_dia deste dia não mudam mais. Sem dado de paciente (a pessoa é um código do agrupamento).';
alter table public.ind_fechamento enable row level security;

create table public.ind_pessoa_dia (
  dia date not null,
  pessoa text not null,
  teste boolean not null,
  unidades text[] default '{}'::text[] not null,
  contatos integer not null,
  entrou boolean not null,
  reentradas integer not null,
  transferencias integer default 0 not null,
  constraint ind_pessoa_dia_pkey PRIMARY KEY (dia, pessoa, teste)
);
alter table public.ind_pessoa_dia enable row level security;

create table public.ind_semhumano_dia (
  dia date not null,
  ordem integer not null,
  pessoa text,
  teste boolean not null,
  unidades text[] default '{}'::text[] not null,
  constraint ind_semhumano_dia_pkey PRIMARY KEY (dia, ordem)
);
alter table public.ind_semhumano_dia enable row level security;

create table public.jornada_acesso (
  id bigint generated always as identity not null,
  card_id bigint not null,
  usuario uuid not null,
  quando timestamp with time zone default now() not null,
  constraint jornada_acesso_pkey PRIMARY KEY (id)
);
alter table public.jornada_acesso enable row level security;
create policy jornada_acesso_select on public.jornada_acesso as permissive for select to authenticated
  using (( SELECT jornada_admin() AS jornada_admin));
-- concessão a authenticated: SELECT

create table public.jornada_card (
  id bigint generated always as identity not null,
  paciente_chave text not null,
  data_ref date not null,
  unidade text default ''::text not null,
  coluna text not null,
  coluna_desde timestamp with time zone default now() not null,
  responsavel uuid,
  prioridade smallint default 0 not null,
  versao integer default 1 not null,
  conversa_id uuid,
  arquivado_em timestamp with time zone,
  criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  constraint jornada_card_prioridade_check CHECK (((prioridade >= 0) AND (prioridade <= 3))),
  constraint jornada_card_pkey PRIMARY KEY (id),
  constraint jornada_card_paciente_chave_data_ref_unidade_key UNIQUE (paciente_chave, data_ref, unidade)
);
CREATE INDEX jornada_card_coluna_idx ON public.jornada_card USING btree (coluna) WHERE (arquivado_em IS NULL);
CREATE INDEX jornada_card_conversa_idx ON public.jornada_card USING btree (conversa_id) WHERE (conversa_id IS NOT NULL);
CREATE INDEX jornada_card_data_idx ON public.jornada_card USING btree (data_ref DESC);
alter table public.jornada_card enable row level security;
create policy jornada_card_select on public.jornada_card as permissive for select to authenticated
  using (( SELECT jornada_pode() AS jornada_pode));
-- concessão a authenticated: SELECT

create table public.jornada_checklist_modelo (
  id bigint generated always as identity not null,
  coluna text not null,
  ordem integer default 1 not null,
  titulo text not null,
  ativa boolean default true not null,
  constraint jornada_checklist_modelo_titulo_check CHECK (((char_length(titulo) >= 3) AND (char_length(titulo) <= 200))),
  constraint jornada_checklist_modelo_pkey PRIMARY KEY (id),
  constraint jornada_checklist_modelo_coluna_titulo_key UNIQUE (coluna, titulo)
);
alter table public.jornada_checklist_modelo enable row level security;
create policy jornada_checklist_modelo_select on public.jornada_checklist_modelo as permissive for select to authenticated
  using (( SELECT jornada_admin() AS jornada_admin));
-- concessão a authenticated: SELECT

create table public.jornada_coluna (
  id text not null,
  nome text not null,
  ordem integer not null,
  etapa text not null,
  origem text not null,
  sla_min integer,
  ativa boolean default true not null,
  constraint jornada_coluna_etapa_check CHECK ((etapa = ANY (ARRAY['antes'::text, 'agendamento'::text, 'depois'::text, 'pos'::text, 'excecao'::text]))),
  constraint jornada_coluna_origem_check CHECK ((origem = ANY (ARRAY['klingo'::text, 'manual'::text]))),
  constraint jornada_coluna_sla_min_check CHECK (((sla_min IS NULL) OR (sla_min > 0))),
  constraint jornada_coluna_pkey PRIMARY KEY (id)
);
comment on table public.jornada_coluna is 'Colunas do quadro da Jornada. origem klingo = automática (Klingo ou chat); manual = só por jornada_mover_card.';
alter table public.jornada_coluna enable row level security;
create policy jornada_coluna_select on public.jornada_coluna as permissive for select to authenticated
  using (( SELECT jornada_pode() AS jornada_pode));
-- concessão a authenticated: SELECT

create table public.jornada_escala (
  coluna text not null,
  usuario uuid not null,
  ativa boolean default true not null,
  constraint jornada_escala_pkey PRIMARY KEY (coluna, usuario)
);
alter table public.jornada_escala enable row level security;
create policy jornada_escala_select on public.jornada_escala as permissive for select to authenticated
  using (( SELECT jornada_admin() AS jornada_admin));
-- concessão a authenticated: SELECT

create table public.jornada_evento (
  id bigint generated always as identity not null,
  card_id bigint not null,
  quando timestamp with time zone default now() not null,
  tipo text not null,
  origem text not null,
  usuario uuid,
  de_coluna text,
  para_coluna text,
  detalhe jsonb default '{}'::jsonb not null,
  constraint jornada_evento_origem_check CHECK ((origem = ANY (ARRAY['klingo'::text, 'pessoa'::text, 'sistema'::text]))),
  constraint jornada_evento_tipo_check CHECK ((tipo = ANY (ARRAY['criado'::text, 'movido'::text, 'divergencia'::text, 'atribuido'::text, 'nota'::text, 'tarefa'::text, 'prioridade'::text]))),
  constraint jornada_evento_pkey PRIMARY KEY (id)
);
CREATE INDEX jornada_evento_card_idx ON public.jornada_evento USING btree (card_id, quando DESC);
alter table public.jornada_evento enable row level security;
create policy jornada_evento_select on public.jornada_evento as permissive for select to authenticated
  using (( SELECT jornada_pode() AS jornada_pode));
-- concessão a authenticated: SELECT

create table public.jornada_exame (
  id bigint generated always as identity not null,
  card_id bigint not null,
  marcacao_id text not null,
  atendimento_id text,
  procedimento text not null,
  operadora text,
  unidade text,
  agendado_em timestamp with time zone,
  agendado_para timestamp with time zone,
  status text default 'agendado'::text not null,
  confirm_status text,
  cancelamento_motivo text,
  atualizado_em timestamp with time zone default now() not null,
  constraint jornada_exame_status_check CHECK ((status = ANY (ARRAY['pedido'::text, 'agendado'::text, 'confirmado'::text, 'atendido'::text, 'cancelado'::text, 'remarcado'::text, 'faltou'::text]))),
  constraint jornada_exame_pkey PRIMARY KEY (id),
  constraint jornada_exame_marcacao_id_key UNIQUE (marcacao_id)
);
CREATE INDEX jornada_exame_card_idx ON public.jornada_exame USING btree (card_id);
alter table public.jornada_exame enable row level security;
create policy jornada_exame_select on public.jornada_exame as permissive for select to authenticated
  using (( SELECT jornada_pode() AS jornada_pode));
-- concessão a authenticated: SELECT

create table public.jornada_mensagem (
  id bigint generated always as identity not null,
  card_id bigint not null,
  autor uuid,
  autor_nome text,
  texto text not null,
  criado_em timestamp with time zone default now() not null,
  constraint jornada_mensagem_texto_check CHECK (((char_length(texto) >= 1) AND (char_length(texto) <= 2000))),
  constraint jornada_mensagem_pkey PRIMARY KEY (id)
);
CREATE INDEX jornada_mensagem_card_idx ON public.jornada_mensagem USING btree (card_id, criado_em);
alter table public.jornada_mensagem enable row level security;
create policy jornada_mensagem_select on public.jornada_mensagem as permissive for select to authenticated
  using (( SELECT jornada_pode() AS jornada_pode));
-- concessão a authenticated: SELECT

create table public.jornada_paciente (
  prontuario text not null,
  nome text,
  fone_chave text,
  atualizado_em timestamp with time zone default now() not null,
  constraint jornada_paciente_pkey PRIMARY KEY (prontuario)
);
CREATE INDEX jornada_paciente_fone_idx ON public.jornada_paciente USING btree (fone_chave) WHERE (fone_chave IS NOT NULL);
alter table public.jornada_paciente enable row level security;
create policy jornada_paciente_select on public.jornada_paciente as permissive for select to authenticated
  using (( SELECT jornada_pode() AS jornada_pode));
-- concessão a authenticated: SELECT

create table public.jornada_pendencia (
  chave text not null,
  ordem integer default 100 not null,
  titulo text not null,
  texto text not null,
  nivel text default 'info'::text not null,
  passos jsonb default '[]'::jsonb not null,
  criada_em timestamp with time zone default now() not null,
  resolvida_em timestamp with time zone,
  resolvida_por uuid,
  resolucao text,
  constraint jornada_pendencia_nivel_check CHECK ((nivel = ANY (ARRAY['critico'::text, 'atencao'::text, 'info'::text]))),
  constraint jornada_pendencia_pkey PRIMARY KEY (chave)
);
alter table public.jornada_pendencia enable row level security;
create policy jornada_pendencia_select on public.jornada_pendencia as permissive for select to authenticated
  using (( SELECT jornada_pode() AS jornada_pode));
-- concessão a authenticated: SELECT

create table public.jornada_regra (
  chave text not null,
  nome text not null,
  descricao text not null,
  ativa boolean default true not null,
  parametros jsonb default '{}'::jsonb not null,
  constraint jornada_regra_pkey PRIMARY KEY (chave)
);
alter table public.jornada_regra enable row level security;
create policy jornada_regra_select on public.jornada_regra as permissive for select to authenticated
  using (( SELECT jornada_admin() AS jornada_admin));
-- concessão a authenticated: SELECT

create table public.jornada_sync_estado (
  id boolean default true not null,
  klingo_em timestamp with time zone,
  klingo_resultado jsonb,
  chat_em timestamp with time zone,
  chat_resultado jsonb,
  klingo_modo text,
  klingo_proximo_em timestamp with time zone,
  klingo_tentativa_em timestamp with time zone,
  klingo_completo_em timestamp with time zone,
  klingo_movimento_em timestamp with time zone,
  klingo_erro text,
  klingo_falhas integer default 0 not null,
  vigia_em timestamp with time zone,
  vigia_resultado jsonb,
  vigia_erro text,
  klingo_fim_em timestamp with time zone,
  constraint jornada_sync_estado_id_check CHECK (id),
  constraint jornada_sync_estado_pkey PRIMARY KEY (id)
);
alter table public.jornada_sync_estado enable row level security;
create policy jornada_sync_estado_select on public.jornada_sync_estado as permissive for select to authenticated
  using (( SELECT jornada_pode() AS jornada_pode));
-- concessão a authenticated: SELECT

create table public.jornada_tarefa (
  id bigint generated always as identity not null,
  card_id bigint not null,
  titulo text not null,
  origem text not null,
  chave text,
  criada_por uuid,
  vence_em timestamp with time zone,
  criada_em timestamp with time zone default now() not null,
  feita_em timestamp with time zone,
  feita_por uuid,
  constraint jornada_tarefa_origem_check CHECK ((origem = ANY (ARRAY['sistema'::text, 'pessoa'::text]))),
  constraint jornada_tarefa_titulo_check CHECK (((char_length(titulo) >= 3) AND (char_length(titulo) <= 200))),
  constraint jornada_tarefa_pkey PRIMARY KEY (id)
);
CREATE INDEX jornada_tarefa_abertas_idx ON public.jornada_tarefa USING btree (card_id) WHERE (feita_em IS NULL);
CREATE UNIQUE INDEX jornada_tarefa_chave_idx ON public.jornada_tarefa USING btree (card_id, chave) WHERE (chave IS NOT NULL);
alter table public.jornada_tarefa enable row level security;
create policy jornada_tarefa_select on public.jornada_tarefa as permissive for select to authenticated
  using (( SELECT jornada_pode() AS jornada_pode));
-- concessão a authenticated: SELECT

create table public.jornada_transicao (
  de text not null,
  para text not null,
  constraint jornada_transicao_pkey PRIMARY KEY (de, para)
);
comment on table public.jornada_transicao is 'Movimentos manuais permitidos entre colunas (de -> para). As colunas automáticas seguem jornada_klingo_pode_mover e jornada_aplicar_chat, não esta tabela.';
alter table public.jornada_transicao enable row level security;
create policy jornada_transicao_select on public.jornada_transicao as permissive for select to authenticated
  using (( SELECT jornada_pode() AS jornada_pode));
-- concessão a authenticated: SELECT

create table public.medico_aviso (
  id bigint generated always as identity not null,
  criado_em timestamp with time zone default now() not null,
  profissional text not null,
  unidade text not null,
  tipo text not null,
  antes jsonb,
  depois jsonb,
  status text default 'pendente'::text not null,
  resolvido_em timestamp with time zone,
  resolvido_por uuid,
  constraint medico_aviso_status_check CHECK ((status = ANY (ARRAY['pendente'::text, 'aceito'::text, 'mantido'::text, 'automatico'::text]))),
  constraint medico_aviso_tipo_check CHECK ((tipo = ANY (ARRAY['novo'::text, 'alterado'::text, 'removido'::text]))),
  constraint medico_aviso_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX medico_aviso_pendente_idx ON public.medico_aviso USING btree (profissional, unidade) WHERE (status = 'pendente'::text);
alter table public.medico_aviso enable row level security;

create table public.medico_base (
  profissional text not null,
  unidade text not null,
  dias integer[] not null,
  hora_ini text not null,
  hora_fim text not null,
  conferido_em timestamp with time zone default now() not null,
  constraint medico_base_pkey PRIMARY KEY (profissional, unidade)
);
comment on table public.medico_base is 'Grade do Klingo (por médico e unidade) na última vez em que a equipe conferiu. A diferença para a grade atual vira aviso.';
alter table public.medico_base enable row level security;

create table public.medico_convenio_bloqueio (
  profissional text not null,
  operadora text not null,
  procedimento_id integer default 0 not null,
  criado_em timestamp with time zone default now() not null,
  criado_por uuid,
  constraint medico_convenio_bloqueio_pkey PRIMARY KEY (profissional, operadora, procedimento_id)
);
alter table public.medico_convenio_bloqueio enable row level security;

create table public.medico_excecao (
  id bigint generated always as identity not null,
  profissional text not null,
  data_ini date not null,
  data_fim date not null,
  motivo text,
  criado_em timestamp with time zone default now() not null,
  criado_por uuid,
  constraint medico_excecao_check CHECK ((data_fim >= data_ini)),
  constraint medico_excecao_pkey PRIMARY KEY (id)
);
CREATE INDEX medico_excecao_prof_idx ON public.medico_excecao USING btree (profissional, data_fim);
alter table public.medico_excecao enable row level security;

create table public.medico_particular (
  profissional text not null,
  criado_em timestamp with time zone default now() not null,
  criado_por uuid,
  constraint medico_particular_pkey PRIMARY KEY (profissional)
);
alter table public.medico_particular enable row level security;

create table public.medico_proc_aviso (
  id bigint generated always as identity not null,
  criado_em timestamp with time zone default now() not null,
  profissional text not null,
  procedimento_id integer not null,
  procedimento text,
  especialidade text,
  status text default 'pendente'::text not null,
  resolvido_em timestamp with time zone,
  resolvido_por uuid,
  constraint medico_proc_aviso_status_check CHECK ((status = ANY (ARRAY['pendente'::text, 'ativo'::text, 'automatico'::text]))),
  constraint medico_proc_aviso_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX medico_proc_aviso_pendente_idx ON public.medico_proc_aviso USING btree (profissional, procedimento_id) WHERE (status = 'pendente'::text);
alter table public.medico_proc_aviso enable row level security;

create table public.medico_proc_base (
  profissional text not null,
  procedimento_id integer not null,
  conferido_em timestamp with time zone default now() not null,
  constraint medico_proc_base_pkey PRIMARY KEY (profissional, procedimento_id)
);
alter table public.medico_proc_base enable row level security;

create table public.medico_regra (
  profissional text not null,
  unidade text not null,
  dias integer[],
  hora_ini text,
  hora_fim text,
  nota text,
  atualizado_em timestamp with time zone default now() not null,
  atualizado_por uuid,
  constraint medico_regra_check CHECK (((hora_ini IS NULL) OR (hora_fim IS NULL) OR (hora_ini < hora_fim))),
  constraint medico_regra_dias_check CHECK (((dias IS NULL) OR (cardinality(dias) > 0))),
  constraint medico_regra_hora_fim_check CHECK (((hora_fim IS NULL) OR (hora_fim ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text))),
  constraint medico_regra_hora_ini_check CHECK (((hora_ini IS NULL) OR (hora_ini ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text))),
  constraint medico_regra_pkey PRIMARY KEY (profissional, unidade)
);
comment on table public.medico_regra is 'Particularidades de cada médico (dias e faixa de horário) como filtro sobre a grade do Klingo. Não é apagada pela sincronização.';
alter table public.medico_regra enable row level security;

create table public.medico_turno (
  profissional text not null,
  unidade text not null,
  dia integer not null,
  hora_ini text not null,
  hora_fim text not null,
  atualizado_em timestamp with time zone default now() not null,
  constraint medico_turno_check CHECK ((hora_ini < hora_fim)),
  constraint medico_turno_dia_check CHECK (((dia >= 0) AND (dia <= 6))),
  constraint medico_turno_hora_fim_check CHECK ((hora_fim ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text)),
  constraint medico_turno_hora_ini_check CHECK ((hora_ini ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text)),
  constraint medico_turno_pkey PRIMARY KEY (profissional, unidade, dia, hora_ini)
);
alter table public.medico_turno enable row level security;

create table public.mensagens (
  id bigint generated always as identity not null,
  conversa_id uuid not null,
  autor text not null,
  agente_id uuid,
  texto text not null,
  criado_em timestamp with time zone default now() not null,
  opcoes jsonb,
  editada_em timestamp with time zone,
  excluida_em timestamp with time zone,
  constraint mensagens_autor_check CHECK ((autor = ANY (ARRAY['cliente'::text, 'agente'::text, 'sistema'::text]))),
  constraint mensagens_texto_check CHECK (((char_length(texto) >= 1) AND (char_length(texto) <= 4000))),
  constraint mensagens_pkey PRIMARY KEY (id)
);
CREATE INDEX mensagens_agente_idx ON public.mensagens USING btree (agente_id);
CREATE INDEX mensagens_conversa_idx ON public.mensagens USING btree (conversa_id, id);
CREATE UNIQUE INDEX mensagens_despedida_unica ON public.mensagens USING btree (conversa_id, ((opcoes ->> 'encerrada_em'::text))) WHERE ((opcoes ->> 'tipo'::text) = 'despedida'::text);
alter table public.mensagens enable row level security;
create policy mensagens_insert on public.mensagens as permissive for insert to authenticated
  with check (((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])) AND (autor = 'agente'::text) AND (agente_id = ( SELECT auth.uid() AS uid))));
create policy mensagens_select on public.mensagens as permissive for select to authenticated
  using (((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])) AND ((NOT ( SELECT permissao_restringe() AS permissao_restringe)) OR pode_ver_conversa(conversa_id))));
-- concessão a authenticated: SELECT

create table public.ocr_aprendido (
  texto_norm text not null,
  procedimento_id integer not null,
  vezes integer default 1 not null,
  exemplo text,
  atualizado_em timestamp with time zone default now() not null,
  constraint ocr_aprendido_pkey PRIMARY KEY (texto_norm, procedimento_id)
);
comment on table public.ocr_aprendido is 'Escrita de pedido médico (normalizada) -> exame, confirmada pela equipe no painel. Só a linha do exame, nunca dado do paciente.';
alter table public.ocr_aprendido enable row level security;
create policy ocr_aprendido_select on public.ocr_aprendido as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.org_alteracao_log (
  id bigint generated always as identity not null,
  em timestamp with time zone default now() not null,
  por uuid,
  acao text not null,
  alvo text,
  antes jsonb,
  depois jsonb,
  constraint org_alteracao_log_pkey PRIMARY KEY (id)
);
alter table public.org_alteracao_log enable row level security;
create policy org_alteracao_log_select on public.org_alteracao_log as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.org_equipe (
  id bigint generated always as identity not null,
  nome text not null,
  unidade text,
  transversal boolean default false not null,
  ativa boolean default true not null,
  criado_em timestamp with time zone default now() not null,
  constraint org_equipe_pkey PRIMARY KEY (id),
  constraint org_equipe_nome_key UNIQUE (nome)
);
alter table public.org_equipe enable row level security;
create policy org_equipe_select on public.org_equipe as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.org_membro (
  id bigint generated always as identity not null,
  equipe_id bigint,
  agente_id uuid,
  rotulo text,
  funcao text not null,
  ativo boolean default true not null,
  inicio date default CURRENT_DATE not null,
  fim date,
  constraint org_membro_check CHECK (((agente_id IS NOT NULL) OR (rotulo IS NOT NULL))),
  constraint org_membro_funcao_check CHECK ((funcao = ANY (ARRAY['ti'::text, 'gerente'::text, 'supervisor'::text, 'atendente'::text]))),
  constraint org_membro_pkey PRIMARY KEY (id)
);
CREATE INDEX org_membro_agente_idx ON public.org_membro USING btree (agente_id) WHERE (agente_id IS NOT NULL);
CREATE UNIQUE INDEX org_membro_conta_uq ON public.org_membro USING btree (COALESCE(equipe_id, (0)::bigint), agente_id) WHERE ((agente_id IS NOT NULL) AND (fim IS NULL));
CREATE UNIQUE INDEX org_membro_rotulo_uq ON public.org_membro USING btree (COALESCE(equipe_id, (0)::bigint), rotulo) WHERE (agente_id IS NULL);
alter table public.org_membro enable row level security;
create policy org_membro_select on public.org_membro as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.paciente_aviso (
  id bigint generated always as identity not null,
  conversa_id uuid not null,
  tipo text not null,
  detalhe jsonb default '{}'::jsonb not null,
  criado_em timestamp with time zone default now() not null,
  resolvido_em timestamp with time zone,
  resolvido_por uuid,
  constraint paciente_aviso_tipo_check CHECK ((tipo = ANY (ARRAY['klingo_ligado'::text, 'klingo_varios'::text, 'dado_diferente'::text, 'cpf_diferente'::text]))),
  constraint paciente_aviso_pkey PRIMARY KEY (id)
);
comment on table public.paciente_aviso is 'Avisos para a equipe sobre o paciente: ligado ao Klingo, mais de um prontuário, dado diferente do cadastro, CPF diferente. Só funções do banco gravam.';
CREATE UNIQUE INDEX paciente_aviso_aberto ON public.paciente_aviso USING btree (conversa_id, tipo) WHERE (resolvido_em IS NULL);
alter table public.paciente_aviso enable row level security;
create policy paciente_aviso_select on public.paciente_aviso as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a anon: REFERENCES,SELECT,TRIGGER,TRUNCATE
-- concessão a authenticated: REFERENCES,SELECT,TRIGGER,TRUNCATE

create table public.paciente_historico (
  id bigint generated always as identity not null,
  paciente_id uuid not null,
  pre_agendamento_id uuid,
  conversa_id uuid,
  ocorreu_em timestamp without time zone,
  unidade text,
  profissional text,
  plano text,
  exames jsonb default '[]'::jsonb not null,
  horarios jsonb default '[]'::jsonb not null,
  origem text not null,
  cancelado boolean default false not null,
  criado_em timestamp with time zone default now() not null,
  constraint paciente_historico_origem_check CHECK ((origem = ANY (ARRAY['automatico'::text, 'manual'::text]))),
  constraint paciente_historico_pkey PRIMARY KEY (id),
  constraint paciente_historico_pre_agendamento_id_key UNIQUE (pre_agendamento_id)
);
comment on table public.paciente_historico is 'Marcações concluídas de cada paciente conhecido (sem dados do Klingo). Só admin/atendente leem; a IA só recebe os detalhes depois da data de nascimento conferida.';
CREATE INDEX paciente_historico_paciente ON public.paciente_historico USING btree (paciente_id, criado_em DESC);
alter table public.paciente_historico enable row level security;
create policy paciente_historico_select on public.paciente_historico as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.paciente_klingo_vinculo (
  conversa_id uuid not null,
  situacao text not null,
  prontuario text,
  cadastro_faltando text[] default '{}'::text[] not null,
  historico jsonb,
  chave text not null,
  verificado_em timestamp with time zone default now() not null,
  constraint paciente_klingo_vinculo_situacao_check CHECK ((situacao = ANY (ARRAY['pendente'::text, 'confere'::text, 'divergente'::text, 'nao_encontrado'::text, 'ambiguo'::text, 'erro'::text]))),
  constraint paciente_klingo_vinculo_pkey PRIMARY KEY (conversa_id)
);
comment on table public.paciente_klingo_vinculo is 'Ligação conversa do chat ↔ prontuário do Klingo, conferida por CPF + nascimento (Edge Function klingo-paciente). Sem nome, telefone, e-mail ou CPF. Só service_role e funções security definer acessam.';
alter table public.paciente_klingo_vinculo enable row level security;

create table public.pacientes (
  id uuid default gen_random_uuid() not null,
  nome text not null,
  nome_norm text not null,
  telefones text[] default '{}'::text[] not null,
  email text,
  dt_nasc date,
  cpf text,
  dados jsonb default '{}'::jsonb not null,
  validado boolean default false not null,
  validado_em timestamp with time zone,
  revisar boolean default false not null,
  origem_conversa uuid,
  criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  ultima_visita_em timestamp with time zone default now() not null,
  email_cadastro text generated always as (lower(email)) stored,
  perfil_biometrico_historico jsonb default '{}'::jsonb not null,
  assinatura_papel_path text,
  constraint pacientes_pkey PRIMARY KEY (id)
);
comment on table public.pacientes is 'Pacientes conhecidos (dados pessoais: CPF, mãe, endereço). validado = identidade conferida (data de nascimento batendo em novo atendimento) ou agendamento confirmado pelo atendente. revisar = CPF repetido ou dados divergentes. Só admin/atendente leem.';
CREATE INDEX pacientes_cpf ON public.pacientes USING btree (cpf);
CREATE INDEX pacientes_email ON public.pacientes USING btree (lower(email));
CREATE INDEX pacientes_nome ON public.pacientes USING btree (nome_norm);
CREATE INDEX pacientes_telefones ON public.pacientes USING gin (telefones);
alter table public.pacientes enable row level security;
create policy pacientes_select on public.pacientes as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
create policy pacientes_update on public.pacientes as permissive for update to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])))
  with check ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a anon: DELETE,INSERT,REFERENCES,TRIGGER,TRUNCATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,TRIGGER,TRUNCATE

create table public.permissao_observacao (
  id bigint generated always as identity not null,
  em timestamp with time zone default now() not null,
  agente_id uuid,
  acao text not null,
  conversa_id uuid,
  unidade text,
  detalhe jsonb default '{}'::jsonb not null,
  constraint permissao_observacao_pkey PRIMARY KEY (id)
);
alter table public.permissao_observacao enable row level security;
create policy permissao_observacao_select on public.permissao_observacao as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.pessoa_klingo_vinculo (
  prontuario text not null,
  conversa_id uuid not null,
  por uuid,
  em timestamp with time zone default now() not null,
  constraint pessoa_klingo_vinculo_pkey PRIMARY KEY (prontuario)
);
comment on table public.pessoa_klingo_vinculo is 'Paciente do Klingo (prontuário ou chave "n:...") que a equipe confirmou ser a pessoa de uma conversa do chat.';
CREATE INDEX pessoa_klingo_vinculo_conversa_idx ON public.pessoa_klingo_vinculo USING btree (conversa_id);
alter table public.pessoa_klingo_vinculo enable row level security;
create policy pessoa_klingo_vinculo_select on public.pessoa_klingo_vinculo as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a authenticated: SELECT

create table public.pre_agendamento_itens (
  id bigint generated always as identity not null,
  conversa_id uuid not null,
  modalidade text,
  regiao text,
  regiao_nome text,
  lado text,
  procedimento_id integer,
  procedimento text,
  quantidade integer default 1 not null,
  ativo boolean default true not null,
  criado_em timestamp with time zone default now() not null,
  constraint pre_agendamento_itens_lado_check CHECK ((lado = ANY (ARRAY['D'::text, 'E'::text, 'A'::text, 'N'::text]))),
  constraint pre_agendamento_itens_quantidade_check CHECK (((quantidade >= 1) AND (quantidade <= 4))),
  constraint pre_agendamento_itens_pkey PRIMARY KEY (id)
);
comment on table public.pre_agendamento_itens is 'Exames do pedido do paciente (vários, com parte do corpo e lado: D direito, E esquerdo, A ambos, N não se aplica). O lado é o que o paciente escolheu, nunca deduzido do desenho do mapa.';
CREATE INDEX pre_agendamento_itens_conversa ON public.pre_agendamento_itens USING btree (conversa_id) WHERE ativo;
alter table public.pre_agendamento_itens enable row level security;
create policy pre_agendamento_itens_select on public.pre_agendamento_itens as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.pre_agendamentos (
  id uuid default gen_random_uuid() not null,
  conversa_id uuid not null,
  tipo text,
  especialidade text,
  procedimento text,
  plano text,
  unidade text,
  profissional text,
  preferencia_horario text,
  paciente jsonb default '{}'::jsonb not null,
  status text default 'rascunho'::text not null,
  klingo_paciente_id text,
  criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  paciente_id uuid,
  identidade text,
  etapa text,
  data_desejada date,
  hora_desejada text,
  escolha_horario jsonb,
  agendado_auto_em timestamp with time zone,
  conferencia_status text,
  conferencia_detalhe text,
  conferencia_via text,
  conferencia_em timestamp with time zone,
  conferencia_falhas integer default 0 not null,
  confirmacao_enviada_em timestamp with time zone,
  escolha_horario_chat jsonb,
  klingo_marcacoes text[],
  agendado_em timestamp with time zone,
  agendado_por uuid,
  agendado_origem text,
  constraint pre_agendamentos_agendado_origem_ck CHECK (((agendado_origem IS NULL) OR (agendado_origem = ANY (ARRAY['equipe'::text, 'reconhecido'::text, 'chat_api'::text])))),
  constraint pre_agendamentos_conferencia_status_check CHECK ((conferencia_status = ANY (ARRAY['confirmado'::text, 'horario_tomado'::text, 'divergente'::text, 'nao_encontrado'::text, 'sumiu'::text, 'remarcado'::text]))),
  constraint pre_agendamentos_conferencia_via_check CHECK ((conferencia_via = ANY (ARRAY['telefone'::text, 'nome'::text, 'ambos'::text]))),
  constraint pre_agendamentos_etapa_check CHECK ((etapa = ANY (ARRAY['pedido'::text, 'plano'::text, 'preferencias'::text, 'data_hora'::text, 'dados'::text, 'confirmacao'::text, 'pronto'::text]))),
  constraint pre_agendamentos_identidade_check CHECK ((identidade = ANY (ARRAY['nova'::text, 'aguardando'::text, 'conferida'::text, 'atualizar'::text, 'divergente'::text]))),
  constraint pre_agendamentos_status_check CHECK ((status = ANY (ARRAY['rascunho'::text, 'pronto'::text, 'agendado'::text, 'cancelado'::text]))),
  constraint pre_agendamentos_tipo_check CHECK ((tipo = ANY (ARRAY['consulta'::text, 'exame'::text]))),
  constraint pre_agendamentos_pkey PRIMARY KEY (id),
  constraint pre_agendamentos_conversa_id_key UNIQUE (conversa_id)
);
comment on table public.pre_agendamentos is 'Pré-agendamento montado pela IA (dados pessoais: CPF, mãe, endereço). Só admin/atendente leem. A marcação real é feita pelo atendente no Klingo.';
alter table public.pre_agendamentos enable row level security;
create policy pre_agendamentos_delete on public.pre_agendamentos as permissive for delete to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
create policy pre_agendamentos_select on public.pre_agendamentos as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
create policy pre_agendamentos_update on public.pre_agendamentos as permissive for update to public
  using ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])))
  with check ((( SELECT papel_atual() AS papel_atual) = ANY (ARRAY['admin'::text, 'atendente'::text])));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.preco_observado (
  procedimento_norm text not null,
  operadora_norm text not null,
  procedimento text not null,
  operadora text not null,
  valor_tipico numeric(12,2) not null,
  valor_min numeric(12,2) not null,
  valor_max numeric(12,2) not null,
  amostras integer not null,
  janela_ini date,
  janela_fim date,
  atualizado_em timestamp with time zone default now() not null,
  constraint preco_observado_amostras_check CHECK ((amostras >= 1)),
  constraint preco_observado_pkey PRIMARY KEY (procedimento_norm, operadora_norm)
);
comment on table public.preco_observado is 'Preço Previsto das marcações do Klingo (relatório #7), agregado por exame e operadora na janela lida. Sem dado de paciente. Serve para conferir o catalogo_preco.';
alter table public.preco_observado enable row level security;
create policy preco_observado_select on public.preco_observado as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.profissional_bloqueio (
  profissional text not null,
  nome text not null,
  motivo text,
  bloqueado_em timestamp with time zone default now() not null,
  bloqueado_por uuid,
  bloqueado_por_nome text,
  constraint profissional_bloqueio_pkey PRIMARY KEY (profissional)
);
comment on table public.profissional_bloqueio is 'Médicos que a equipe bloqueou no painel: o chat não os oferece nem mostra horário deles. Fica fora das tabelas que a sincronização do Klingo apaga e recria. Só as funções profissional_* e agenda_medica_* leem e gravam.';
alter table public.profissional_bloqueio enable row level security;

create table public.profissional_bloqueio_log (
  id bigint generated always as identity not null,
  profissional text not null,
  nome text not null,
  acao text not null,
  motivo text,
  por uuid,
  por_nome text,
  conversas_afetadas integer default 0 not null,
  em timestamp with time zone default now() not null,
  constraint profissional_bloqueio_log_acao_check CHECK ((acao = ANY (ARRAY['bloqueou'::text, 'liberou'::text]))),
  constraint profissional_bloqueio_log_pkey PRIMARY KEY (id)
);
alter table public.profissional_bloqueio_log enable row level security;

create table public.push_inscricao (
  id bigint generated always as identity not null,
  conta_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  criado_em timestamp with time zone default now() not null,
  constraint push_inscricao_endpoint_check CHECK ((char_length(endpoint) <= 1000)),
  constraint push_inscricao_pkey PRIMARY KEY (id),
  constraint push_inscricao_endpoint_key UNIQUE (endpoint)
);
comment on table public.push_inscricao is 'Aparelhos que aceitaram notificação (Web Push). Só as funções fila_push_* e a Edge Function (service_role) acessam.';
alter table public.push_inscricao enable row level security;

create table public.registro_assinaturas (
  id uuid default gen_random_uuid() not null,
  atendimento_id uuid not null,
  email_confirmado_transacao text not null,
  hash_documento text not null,
  consentimento_biometrico boolean not null,
  tipo_validacao text not null,
  score_similaridade numeric(5,4),
  vetor_traco_bruto jsonb not null,
  caracteristicas jsonb not null,
  ip_origem text,
  user_agent text not null,
  created_at timestamp with time zone default now() not null,
  constraint registro_assinaturas_consentimento_biometrico_check CHECK (consentimento_biometrico),
  constraint registro_assinaturas_hash_documento_check CHECK ((hash_documento ~ '^[0-9a-f]{64}$'::text)),
  constraint registro_assinaturas_tipo_validacao_check CHECK ((tipo_validacao = ANY (ARRAY['enrolamento'::text, 'comparacao'::text]))),
  constraint registro_assinaturas_user_agent_check CHECK ((char_length(user_agent) <= 500)),
  constraint registro_score_coerente CHECK ((((tipo_validacao = 'enrolamento'::text) AND (score_similaridade IS NULL)) OR ((tipo_validacao = 'comparacao'::text) AND (score_similaridade IS NOT NULL)))),
  constraint registro_assinaturas_pkey PRIMARY KEY (id),
  constraint registro_assinaturas_atendimento_id_key UNIQUE (atendimento_id)
);
comment on table public.registro_assinaturas is 'Lastro jurídico da assinatura. Imutável: UPDATE, DELETE e TRUNCATE são bloqueados por trigger. Só admin lê.';
alter table public.registro_assinaturas enable row level security;
create policy registro_assinaturas_admin on public.registro_assinaturas as permissive for select to authenticated
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a authenticated: SELECT

create table public.respostas_prontas (
  id uuid default gen_random_uuid() not null,
  atalho text not null,
  texto text not null,
  criado_em timestamp with time zone default now() not null,
  atualizado_em timestamp with time zone default now() not null,
  constraint respostas_prontas_atalho_ck CHECK ((atalho ~ '^[A-Za-z0-9À-ÖØ-öø-ÿ_-]{1,50}$'::text)),
  constraint respostas_prontas_texto_ck CHECK (((length(btrim(texto)) >= 1) AND (length(btrim(texto)) <= 4000))),
  constraint respostas_prontas_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX respostas_prontas_atalho_lower_uq ON public.respostas_prontas USING btree (lower(atalho));
alter table public.respostas_prontas enable row level security;
create policy respostas_prontas_delete on public.respostas_prontas as permissive for delete to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
create policy respostas_prontas_insert on public.respostas_prontas as permissive for insert to public
  with check ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
create policy respostas_prontas_select on public.respostas_prontas as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) IS NOT NULL));
create policy respostas_prontas_update on public.respostas_prontas as permissive for update to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text))
  with check ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.unidade_config (
  chave text not null,
  catalogo text not null,
  rotulo text not null,
  descricao text not null,
  fluxo text not null,
  instrucao text not null,
  ordem integer default 0 not null,
  ativo boolean default true not null,
  constraint unidade_config_fluxo_check CHECK ((fluxo = ANY (ARRAY['pediatria'::text, 'exame_consulta'::text]))),
  constraint unidade_config_pkey PRIMARY KEY (chave)
);
comment on table public.unidade_config is 'Unidades escolhidas no início do chat. fluxo = tipo de atendimento previsto (pediatria | exame_consulta); instrucao é lida pela IA. Sem policy: só funções security definer acessam.';
alter table public.unidade_config enable row level security;
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.vinculo_log (
  id bigint generated always as identity not null,
  em timestamp with time zone default now() not null,
  por uuid,
  acao text not null,
  prontuario text,
  conversa_id uuid,
  antes jsonb,
  depois jsonb,
  constraint vinculo_log_pkey PRIMARY KEY (id)
);
alter table public.vinculo_log enable row level security;
create policy vinculo_log_select on public.vinculo_log as permissive for select to public
  using ((( SELECT papel_atual() AS papel_atual) = 'admin'::text));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create table public.vinculo_solicitacoes (
  id bigint generated always as identity not null,
  conta_id uuid not null,
  paciente_id uuid not null,
  tipo text not null,
  batem text[] default '{}'::text[] not null,
  diferem text[] default '{}'::text[] not null,
  conta_nome text,
  conta_telefone text,
  status text default 'aberta'::text not null,
  criado_em timestamp with time zone default now() not null,
  decidido_em timestamp with time zone,
  decidido_por uuid,
  novo_email text,
  novo_telefone text,
  constraint vinculo_solicitacoes_status_check CHECK ((status = ANY (ARRAY['aberta'::text, 'vinculada'::text, 'recusada'::text, 'conferida'::text, 'atualizada'::text, 'desfeita'::text, 'aplicada'::text]))),
  constraint vinculo_solicitacoes_tipo_check CHECK ((tipo = ANY (ARRAY['verificar'::text, 'atualizar'::text, 'alterar'::text]))),
  constraint vinculo_solicitacoes_pkey PRIMARY KEY (id)
);
comment on table public.vinculo_solicitacoes is 'Fila do atendente: contas ligadas com 3 acertos ou CPF (conferir/atualizar), contas com só nome e nascimento (decidir se vincula) e pedidos de mudança de e-mail/telefone com CPF conferido (alterar). Uma linha aberta por conta e tipo.';
CREATE INDEX vinculo_solicitacoes_abertas ON public.vinculo_solicitacoes USING btree (criado_em) WHERE (status = 'aberta'::text);
CREATE INDEX vinculo_solicitacoes_conta ON public.vinculo_solicitacoes USING btree (conta_id);
CREATE UNIQUE INDEX vinculo_solicitacoes_uma_aberta ON public.vinculo_solicitacoes USING btree (conta_id, tipo) WHERE (status = 'aberta'::text);
alter table public.vinculo_solicitacoes enable row level security;

create table public.klingo_convenio (
  plano_id integer primary key,
  convenio_id integer not null,
  convenio text not null,
  plano text not null,
  convenio_norm text not null,
  padrao boolean not null default false,
  visto_em timestamptz not null default now()
);
alter table public.klingo_convenio enable row level security;
create table public.klingo_conversa_ident (
  conversa_id uuid primary key references public.conversas (id) on delete cascade,
  chave text not null,
  em timestamptz not null default now()
);
alter table public.klingo_conversa_ident enable row level security;
create table public.klingo_cota (
  id boolean primary key default true check (id),
  fichas numeric not null default 10,
  max_fichas numeric not null default 10,
  reposicao_por_s numeric not null default 1,
  reposto_em timestamptz not null default clock_timestamp(),
  pausado_ate timestamptz,
  ultimo_429_em timestamptz
);
alter table public.klingo_cota enable row level security;
create table public.klingo_decisao (
  id bigint generated always as identity primary key,
  em timestamptz not null default now(),
  chave text not null,
  de text,
  para text,
  motivo jsonb not null default '{}'::jsonb
);
alter table public.klingo_decisao enable row level security;
create table public.klingo_especialidade (
  cbos text primary key,
  nome text not null,
  codigo text,
  procedimentos integer[] not null default '{}',
  liberada_api boolean not null default true,
  atualizado_em timestamptz not null default now()
);
alter table public.klingo_especialidade enable row level security;
create table public.klingo_evento (
  id bigint generated always as identity primary key,
  hash text not null unique,
  evento text,
  id_marcacao text,
  status text,
  recebido_em timestamptz not null default now(),
  processado_em timestamptz,
  resultado text
);
alter table public.klingo_evento enable row level security;
create table public.klingo_identidade (
  id uuid primary key default gen_random_uuid(),
  chave text not null unique,
  cpf_hash text not null,
  tipo text check (tipo in ('definitivo', 'pre')),
  klingo_id text,
  situacao text not null check (situacao in ('confere', 'divergente', 'nao_encontrado', 'sem_id_definitivo', 'erro', 'pre_cadastro')),
  faltando text[] not null default '{}',
  plano_id integer,
  conferido_em timestamptz not null default now(),
  convertido_em timestamptz,
  criado_pela_operacao uuid,
  constraint klingo_identidade_id_ck check (klingo_id is null or (tipo = 'definitivo' and klingo_id ~ '^P[0-9]+$') or (tipo = 'pre' and klingo_id ~ '^[0-9]+$'))
);
alter table public.klingo_identidade enable row level security;
create table public.klingo_medida (
  dia date not null,
  tipo text not null,
  n bigint not null default 0,
  soma_ms bigint not null default 0,
  primary key (dia, tipo)
);
alter table public.klingo_medida enable row level security;
create table public.klingo_oferta (
  id bigint generated always as identity primary key,
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  chave text not null,
  procedimento integer not null,
  plano integer not null,
  data date not null,
  hora text not null,
  profissional text,
  profissional_id text,
  unidade text,
  unidade_id text,
  ordem_chegada boolean not null default false,
  criado_em timestamptz not null default now(),
  expira_em timestamptz not null,
  unique (conversa_id, chave)
);
alter table public.klingo_oferta enable row level security;
create table public.klingo_operacao (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  pre_agendamento_id uuid references public.pre_agendamentos (id) on delete set null,
  tipo text not null check (tipo in ('marcar', 'cancelar', 'remarcar', 'ler_vouchers')),
  estado text not null default 'pendente' check (estado in ('pendente', 'executando', 'sucesso', 'falha', 'incerto', 'horario_tomado', 'cancelada')),
  chave_idem text not null unique,
  tentativas integer not null default 0,
  voucher_id text,
  http_status integer,
  caminho text,
  codigo text,
  detalhe jsonb not null default '{}'::jsonb,
  origem text not null default 'chat' check (origem in ('chat', 'equipe', 'sistema')),
  criado_em timestamptz not null default now(),
  iniciado_em timestamptz,
  concluido_em timestamptz
);
alter table public.klingo_operacao enable row level security;
create table public.klingo_plano_map (
  operadora text primary key,
  convenio_id integer,
  plano_id integer,
  origem text not null check (origem in ('auto', 'manual', 'nao_atende')),
  atualizado_em timestamptz not null default now()
);
alter table public.klingo_plano_map enable row level security;
create table public.klingo_proc_api (
  procedimento_id integer primary key,
  com_horario_em timestamptz,
  vazio_em timestamptz
);
alter table public.klingo_proc_api enable row level security;
create unique index klingo_identidade_pre_uq on public.klingo_identidade using btree (cpf_hash) where (tipo = 'pre');
create index klingo_identidade_cpf_idx on public.klingo_identidade using btree (cpf_hash);
create index klingo_convenio_conv_idx on public.klingo_convenio using btree (convenio_id);
create index klingo_oferta_exp_idx on public.klingo_oferta using btree (expira_em);
create index klingo_operacao_conv_idx on public.klingo_operacao using btree (conversa_id, criado_em desc);
create index klingo_operacao_estado_idx on public.klingo_operacao using btree (estado, criado_em);

-- ===== Chaves estrangeiras (depois de todas as tabelas) =====
alter table public.agendamento_fechamento add constraint agendamento_fechamento_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.agendamento_fechamento add constraint agendamento_fechamento_por_fkey FOREIGN KEY (por) REFERENCES agentes(id) ON DELETE SET NULL;
alter table public.agendamento_fechamento add constraint agendamento_fechamento_pre_id_fkey FOREIGN KEY (pre_id) REFERENCES pre_agendamentos(id) ON DELETE SET NULL;
alter table public.agendamento_fechamento add constraint agendamento_fechamento_remarcacao_conversa_fkey FOREIGN KEY (remarcacao_conversa) REFERENCES conversas(id) ON DELETE SET NULL;
alter table public.agentes add constraint agentes_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.alerta_preco add constraint alerta_preco_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.alerta_preco add constraint alerta_preco_mensagem_id_fkey FOREIGN KEY (mensagem_id) REFERENCES mensagens(id) ON DELETE SET NULL;
alter table public.assinatura_tentativas add constraint assinatura_tentativas_atendimento_id_fkey FOREIGN KEY (atendimento_id) REFERENCES atendimentos(id) ON DELETE RESTRICT;
alter table public.atendimentos add constraint atendimentos_paciente_id_fkey FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE RESTRICT;
alter table public.autoencerramento_fechada add constraint autoencerramento_fechada_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.avaliacao_atendimento add constraint avaliacao_atendimento_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.catalogo_preco_revisao add constraint catalogo_preco_revisao_procedimento_id_fkey FOREIGN KEY (procedimento_id) REFERENCES catalogo_procedimento(id) ON DELETE CASCADE;
alter table public.chat_push_inscricao add constraint chat_push_inscricao_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.contas_paciente add constraint contas_paciente_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.contas_paciente add constraint contas_paciente_paciente_id_fkey FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE SET NULL;
alter table public.conversa_agendado_conferencia add constraint conversa_agendado_conferencia_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.conversa_anexo add constraint conversa_anexo_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.conversa_anexo add constraint conversa_anexo_gabarito_por_fkey FOREIGN KEY (gabarito_por) REFERENCES agentes(id) ON DELETE SET NULL;
alter table public.conversa_encerramento add constraint conversa_encerramento_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.conversa_evento add constraint conversa_evento_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.conversa_fluxo add constraint conversa_fluxo_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.conversa_grupo add constraint conversa_grupo_confirmado_por_fkey FOREIGN KEY (confirmado_por) REFERENCES agentes(id) ON DELETE SET NULL;
alter table public.conversa_grupo add constraint conversa_grupo_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.conversa_grupo_recusa add constraint conversa_grupo_recusa_a_fkey FOREIGN KEY (a) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.conversa_grupo_recusa add constraint conversa_grupo_recusa_b_fkey FOREIGN KEY (b) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.conversa_grupo_recusa add constraint conversa_grupo_recusa_por_fkey FOREIGN KEY (por) REFERENCES agentes(id) ON DELETE SET NULL;
alter table public.conversa_segredo add constraint conversa_segredo_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.conversas add constraint conversas_agente_id_fkey FOREIGN KEY (agente_id) REFERENCES agentes(id) ON DELETE SET NULL;
alter table public.conversas add constraint conversas_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.conversas add constraint conversas_contato_id_fkey FOREIGN KEY (contato_id) REFERENCES contatos(id) ON DELETE CASCADE;
alter table public.conversas add constraint conversas_irmao_de_fkey FOREIGN KEY (irmao_de) REFERENCES conversas(id) ON DELETE SET NULL;
alter table public.conversas add constraint conversas_reentrada_de_fkey FOREIGN KEY (reentrada_de) REFERENCES conversas(id) ON DELETE SET NULL;
alter table public.conversas add constraint conversas_unidade_inicial_fkey FOREIGN KEY (unidade_inicial) REFERENCES unidade_config(chave);
alter table public.equipe_convites add constraint equipe_convites_criado_por_fkey FOREIGN KEY (criado_por) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.equipe_notificacao add constraint equipe_notificacao_agente_id_fkey FOREIGN KEY (agente_id) REFERENCES agentes(id) ON DELETE CASCADE;
alter table public.equipe_notificacao add constraint equipe_notificacao_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.fila_aviso add constraint fila_aviso_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.fila_aviso add constraint fila_aviso_fila_id_fkey FOREIGN KEY (fila_id) REFERENCES fila_chegada(id) ON DELETE CASCADE;
alter table public.fila_chegada add constraint fila_chegada_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.fila_chegada add constraint fila_chegada_paciente_id_fkey FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE SET NULL;
alter table public.fluxo_evento add constraint fluxo_evento_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.ia_evento add constraint ia_evento_pre_agendamento_id_fkey FOREIGN KEY (pre_agendamento_id) REFERENCES pre_agendamentos(id) ON DELETE SET NULL;
alter table public.incidente_chat add constraint incidente_chat_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE SET NULL;
alter table public.jornada_acesso add constraint jornada_acesso_card_id_fkey FOREIGN KEY (card_id) REFERENCES jornada_card(id);
alter table public.jornada_card add constraint jornada_card_coluna_fkey FOREIGN KEY (coluna) REFERENCES jornada_coluna(id);
alter table public.jornada_checklist_modelo add constraint jornada_checklist_modelo_coluna_fkey FOREIGN KEY (coluna) REFERENCES jornada_coluna(id);
alter table public.jornada_escala add constraint jornada_escala_coluna_fkey FOREIGN KEY (coluna) REFERENCES jornada_coluna(id);
alter table public.jornada_evento add constraint jornada_evento_card_id_fkey FOREIGN KEY (card_id) REFERENCES jornada_card(id);
alter table public.jornada_exame add constraint jornada_exame_card_id_fkey FOREIGN KEY (card_id) REFERENCES jornada_card(id);
alter table public.jornada_mensagem add constraint jornada_mensagem_card_id_fkey FOREIGN KEY (card_id) REFERENCES jornada_card(id);
alter table public.jornada_tarefa add constraint jornada_tarefa_card_id_fkey FOREIGN KEY (card_id) REFERENCES jornada_card(id);
alter table public.jornada_transicao add constraint jornada_transicao_de_fkey FOREIGN KEY (de) REFERENCES jornada_coluna(id);
alter table public.jornada_transicao add constraint jornada_transicao_para_fkey FOREIGN KEY (para) REFERENCES jornada_coluna(id);
alter table public.mensagens add constraint mensagens_agente_id_fkey FOREIGN KEY (agente_id) REFERENCES agentes(id) ON DELETE SET NULL;
alter table public.mensagens add constraint mensagens_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.ocr_aprendido add constraint ocr_aprendido_procedimento_id_fkey FOREIGN KEY (procedimento_id) REFERENCES catalogo_procedimento(id) ON DELETE CASCADE;
alter table public.org_membro add constraint org_membro_agente_id_fkey FOREIGN KEY (agente_id) REFERENCES agentes(id) ON DELETE SET NULL;
alter table public.org_membro add constraint org_membro_equipe_id_fkey FOREIGN KEY (equipe_id) REFERENCES org_equipe(id) ON DELETE CASCADE;
alter table public.paciente_aviso add constraint paciente_aviso_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.paciente_aviso add constraint paciente_aviso_resolvido_por_fkey FOREIGN KEY (resolvido_por) REFERENCES agentes(id) ON DELETE SET NULL;
alter table public.paciente_historico add constraint paciente_historico_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE SET NULL;
alter table public.paciente_historico add constraint paciente_historico_paciente_id_fkey FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE CASCADE;
alter table public.paciente_historico add constraint paciente_historico_pre_agendamento_id_fkey FOREIGN KEY (pre_agendamento_id) REFERENCES pre_agendamentos(id) ON DELETE SET NULL;
alter table public.paciente_klingo_vinculo add constraint paciente_klingo_vinculo_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.pacientes add constraint pacientes_origem_conversa_fkey FOREIGN KEY (origem_conversa) REFERENCES conversas(id) ON DELETE SET NULL;
alter table public.pessoa_klingo_vinculo add constraint pessoa_klingo_vinculo_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.pessoa_klingo_vinculo add constraint pessoa_klingo_vinculo_por_fkey FOREIGN KEY (por) REFERENCES agentes(id) ON DELETE SET NULL;
alter table public.pre_agendamento_itens add constraint pre_agendamento_itens_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.pre_agendamentos add constraint pre_agendamentos_conversa_id_fkey FOREIGN KEY (conversa_id) REFERENCES conversas(id) ON DELETE CASCADE;
alter table public.pre_agendamentos add constraint pre_agendamentos_paciente_id_fkey FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE SET NULL;
alter table public.push_inscricao add constraint push_inscricao_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.registro_assinaturas add constraint registro_assinaturas_atendimento_id_fkey FOREIGN KEY (atendimento_id) REFERENCES atendimentos(id) ON DELETE RESTRICT;
alter table public.vinculo_solicitacoes add constraint vinculo_solicitacoes_conta_id_fkey FOREIGN KEY (conta_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.vinculo_solicitacoes add constraint vinculo_solicitacoes_decidido_por_fkey FOREIGN KEY (decidido_por) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.vinculo_solicitacoes add constraint vinculo_solicitacoes_paciente_id_fkey FOREIGN KEY (paciente_id) REFERENCES pacientes(id) ON DELETE CASCADE;

-- ===== Visões (5) =====

create materialized view public.fluxo_exames as
 SELECT id,
    nome,
    modalidade,
    COALESCE(demanda_90d, 0) AS demanda,
    fluxo_norm_exame(nome) AS chave,
    regexp_replace(norm_nome(nome), 'NAO INCLUI.*$'::text, ''::text) AS chave_reg
   FROM catalogo_procedimento p
  WHERE ativo AND modalidade <> 'CONSULTA'::text AND norm_nome(nome) !~ 'ACRESCENTAR|\mPCTE\M|PACOTE|\mCONTRASTE\M|RECONSTRUCAO|PLANEJAMENTO|PUNCAO|BIOPSIA|DRENAGEM|AMNIOCENTESE|RADIOCIRURGIA|SEDACAO|ADICIONAL|BISNAGA'::text AND (EXISTS ( SELECT 1
           FROM catalogo_agenda a
          WHERE a.procedimento_id = p.id AND a.vig_fim >= CURRENT_DATE AND a.profissional !~* 'teste'::text));
CREATE UNIQUE INDEX fluxo_exames_id ON public.fluxo_exames USING btree (id);

create view public.ocr_treino with (security_invoker=true) as
 SELECT id,
    criado_em,
    ocr_motor,
    ocr_texto,
    ia_modelo,
    ia_ms,
    ia_leitura,
    escolha,
    gabarito,
    gabarito_em,
    ( SELECT count(*) AS count
           FROM jsonb_array_elements(COALESCE(a.gabarito, '[]'::jsonb)) g(value)
          WHERE (EXISTS ( SELECT 1
                   FROM jsonb_array_elements(COALESCE(a.ia_leitura -> 'exames'::text, '[]'::jsonb)) e(value),
                    LATERAL jsonb_array_elements(COALESCE(e.value -> 'opcoes'::text, '[]'::jsonb)) o(value),
                    LATERAL jsonb_array_elements(COALESCE(o.value -> 'ids'::text, '[]'::jsonb)) i(value)
                  WHERE i.value::text = (g.value ->> 'procedimento_id'::text)))) AS ia_acertos,
    jsonb_array_length(COALESCE(gabarito, '[]'::jsonb)) AS exames_confirmados
   FROM conversa_anexo a
  WHERE gabarito IS NOT NULL;

create view public.v_agendamento_aberto with (security_invoker=on) as
 WITH b AS (
         SELECT pa.id AS pre_id,
            pa.conversa_id,
            pa.plano,
            pa.unidade,
            ( SELECT min(((e.value ->> 'data'::text)::date) + ((e.value ->> 'hora'::text)::time without time zone)) AS min
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof(pa.escolha_horario) = 'array'::text THEN pa.escolha_horario
                            ELSE '[]'::jsonb
                        END) e(value)) AS quando,
            ( SELECT string_agg(COALESCE(NULLIF(i.procedimento, ''::text), i.modalidade), ' + '::text ORDER BY i.id) AS string_agg
                   FROM pre_agendamento_itens i
                  WHERE i.conversa_id = pa.conversa_id AND i.ativo) AS exames
           FROM pre_agendamentos pa
          WHERE pa.status = 'agendado'::text
        ), k AS (
         SELECT b.pre_id,
            b.conversa_id,
            b.plano,
            b.unidade,
            b.quando,
            b.exames,
            (b.pre_id::text || '|'::text) || COALESCE(to_char(b.quando, 'YYYY-MM-DD"T"HH24:MI'::text), ''::text) AS chave
           FROM b
        )
 SELECT pre_id,
    conversa_id,
    chave,
    quando,
    exames,
    plano,
    unidade,
    COALESCE(quando < (now() AT TIME ZONE 'America/Bahia'::text), false) AS passou
   FROM k
  WHERE NOT (EXISTS ( SELECT 1
           FROM agendamento_fechamento f
          WHERE f.chave = k.chave));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

create view public.v_jornada_quadro with (security_invoker=true) as
 SELECT c.id,
    c.paciente_chave,
    p.nome AS paciente_nome,
    c.data_ref,
    c.unidade,
    c.coluna,
    k.nome AS coluna_nome,
    k.etapa,
    k.origem,
    k.ordem,
    c.coluna_desde,
    c.responsavel,
    c.prioridade,
    c.versao,
    c.conversa_id,
    n.n_exames,
    n.n_ativos,
    n.n_mensagens,
    n.n_ativos = 0 AND n.n_mensagens = 0 AND k.origem = 'klingo'::text AS vazio,
    k.sla_min IS NOT NULL AND (now() - c.coluna_desde) > make_interval(mins => k.sla_min) AS atrasado,
    floor(EXTRACT(epoch FROM now() - c.coluna_desde) / 60::numeric)::integer AS minutos_na_coluna,
    n.n_tarefas_abertas,
    n.n_tarefas_vencidas,
    n.primeiro_exame,
    n.proxima_hora
   FROM jornada_card c
     JOIN jornada_coluna k ON k.id = c.coluna
     LEFT JOIN jornada_paciente p ON p.prontuario = c.paciente_chave
     CROSS JOIN LATERAL ( SELECT (( SELECT count(*) AS count
                   FROM jornada_exame e
                  WHERE e.card_id = c.id))::integer AS n_exames,
            (( SELECT count(*) AS count
                   FROM jornada_exame e
                  WHERE e.card_id = c.id AND (e.status <> ALL (ARRAY['cancelado'::text, 'remarcado'::text]))))::integer AS n_ativos,
            (( SELECT count(*) AS count
                   FROM jornada_mensagem m
                  WHERE m.card_id = c.id))::integer AS n_mensagens,
            (( SELECT count(*) AS count
                   FROM jornada_tarefa t
                  WHERE t.card_id = c.id AND t.feita_em IS NULL))::integer AS n_tarefas_abertas,
            (( SELECT count(*) AS count
                   FROM jornada_tarefa t
                  WHERE t.card_id = c.id AND t.feita_em IS NULL AND t.vence_em < now()))::integer AS n_tarefas_vencidas,
            ( SELECT e.procedimento
                   FROM jornada_exame e
                  WHERE e.card_id = c.id AND (e.status <> ALL (ARRAY['cancelado'::text, 'remarcado'::text]))
                  ORDER BY e.agendado_para, e.id
                 LIMIT 1) AS primeiro_exame,
            ( SELECT min(e.agendado_para) AS min
                   FROM jornada_exame e
                  WHERE e.card_id = c.id AND (e.status <> ALL (ARRAY['cancelado'::text, 'remarcado'::text]))) AS proxima_hora) n
  WHERE c.arquivado_em IS NULL;
-- concessão a authenticated: SELECT

create view public.v_remarcacao_pendente with (security_invoker=on) as
 SELECT id AS fechamento_id,
    conversa_id,
    exames,
    quando,
    desfecho,
    remarcacao,
    remarcacao_conversa,
    origem,
    fechado_em
   FROM agendamento_fechamento f
  WHERE (desfecho = ANY (ARRAY['faltou'::text, 'remarcou'::text])) AND (remarcacao = ANY (ARRAY['pendente'::text, 'pedida'::text, 'aceita'::text]));
-- concessão a anon: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE
-- concessão a authenticated: DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE

-- ===== Gatilhos (as funções estão em funcoes/) =====
CREATE TRIGGER assinatura_tentativas_imutavel BEFORE DELETE OR UPDATE ON public.assinatura_tentativas FOR EACH ROW EXECUTE FUNCTION registro_imutavel_trg();
CREATE TRIGGER assinatura_tentativas_sem_truncate BEFORE TRUNCATE ON public.assinatura_tentativas FOR EACH STATEMENT EXECUTE FUNCTION registro_imutavel_trg();
CREATE TRIGGER atendimentos_fila_avisar AFTER INSERT OR DELETE OR UPDATE OF status, bloqueado_em ON public.atendimentos FOR EACH ROW EXECUTE FUNCTION fila_avisar_trg();
CREATE TRIGGER atendimentos_transicao BEFORE UPDATE ON public.atendimentos FOR EACH ROW EXECUTE FUNCTION atendimentos_transicao_trg();
CREATE TRIGGER catalogo_agenda_hash BEFORE INSERT ON public.catalogo_agenda FOR EACH ROW EXECUTE FUNCTION catalogo_agenda_hash_trg();
CREATE TRIGGER medico_detectar_meta AFTER INSERT OR UPDATE ON public.catalogo_meta FOR EACH ROW EXECUTE FUNCTION medico_detectar_trg();
CREATE TRIGGER convenio_evento_catalogo AFTER INSERT ON public.catalogo_mudanca FOR EACH ROW EXECUTE FUNCTION convenio_evento_catalogo_trg();
CREATE TRIGGER catalogo_preco_confianca BEFORE INSERT OR UPDATE ON public.catalogo_preco FOR EACH ROW EXECUTE FUNCTION catalogo_preco_confianca_trg();
CREATE TRIGGER conversa_fluxo_klingo_trg AFTER INSERT OR UPDATE OF dados ON public.conversa_fluxo FOR EACH ROW EXECUTE FUNCTION conversa_fluxo_klingo_trg();
CREATE TRIGGER conversa_exame_aberto BEFORE UPDATE OF status ON public.conversas FOR EACH ROW EXECUTE FUNCTION conversa_exame_aberto_trg();
CREATE TRIGGER conversa_limpa_aguarda_paciente BEFORE UPDATE OF status ON public.conversas FOR EACH ROW EXECUTE FUNCTION conversa_limpa_aguarda_paciente_trg();
CREATE TRIGGER conversa_valida_agendado BEFORE UPDATE OF status ON public.conversas FOR EACH ROW EXECUTE FUNCTION conversa_valida_agendado_trg();
CREATE TRIGGER conversas_antes_update BEFORE UPDATE ON public.conversas FOR EACH ROW EXECUTE FUNCTION conversa_antes_update();
CREATE TRIGGER conversas_apos_update AFTER UPDATE ON public.conversas FOR EACH ROW EXECUTE FUNCTION conversa_status_mudou();
CREATE TRIGGER conversas_conta BEFORE INSERT ON public.conversas FOR EACH ROW EXECUTE FUNCTION conversas_conta_trg();
CREATE TRIGGER conversas_motor BEFORE INSERT ON public.conversas FOR EACH ROW EXECUTE FUNCTION conversas_motor_trg();
CREATE TRIGGER conversas_zz_evento AFTER INSERT OR UPDATE ON public.conversas FOR EACH ROW EXECUTE FUNCTION conversas_evento_trg();
CREATE TRIGGER conversas_zz_teste BEFORE INSERT OR UPDATE ON public.conversas FOR EACH ROW EXECUTE FUNCTION conversas_teste_trg();
CREATE TRIGGER conversas_zz_transferencia BEFORE UPDATE OF agente_id ON public.conversas FOR EACH ROW EXECUTE FUNCTION conversa_transferida_reinicia_trg();
CREATE TRIGGER pessoa_agrupar_conversa AFTER INSERT OR UPDATE OF nome_informado, email_informado, paciente_nome, conta_id ON public.conversas FOR EACH ROW EXECUTE FUNCTION pessoa_agrupar_conversa_trg();
CREATE TRIGGER fila_chegada_aviso AFTER INSERT OR UPDATE OF status, conta_id ON public.fila_chegada FOR EACH STATEMENT EXECUTE FUNCTION fila_chegada_trg();
CREATE TRIGGER ind_conclusao_dia_imutavel BEFORE DELETE OR UPDATE ON public.ind_conclusao_dia FOR EACH ROW EXECUTE FUNCTION ind_imutavel_trg();
CREATE TRIGGER ind_conclusao_dia_imutavel_t BEFORE TRUNCATE ON public.ind_conclusao_dia FOR EACH STATEMENT EXECUTE FUNCTION ind_imutavel_trg();
CREATE TRIGGER ind_fechamento_imutavel BEFORE DELETE OR UPDATE ON public.ind_fechamento FOR EACH ROW EXECUTE FUNCTION ind_imutavel_trg();
CREATE TRIGGER ind_fechamento_imutavel_t BEFORE TRUNCATE ON public.ind_fechamento FOR EACH STATEMENT EXECUTE FUNCTION ind_imutavel_trg();
CREATE TRIGGER ind_pessoa_dia_imutavel BEFORE DELETE OR UPDATE ON public.ind_pessoa_dia FOR EACH ROW EXECUTE FUNCTION ind_imutavel_trg();
CREATE TRIGGER ind_pessoa_dia_imutavel_t BEFORE TRUNCATE ON public.ind_pessoa_dia FOR EACH STATEMENT EXECUTE FUNCTION ind_imutavel_trg();
CREATE TRIGGER ind_semhumano_dia_imutavel BEFORE DELETE OR UPDATE ON public.ind_semhumano_dia FOR EACH ROW EXECUTE FUNCTION ind_imutavel_trg();
CREATE TRIGGER ind_semhumano_dia_imutavel_t BEFORE TRUNCATE ON public.ind_semhumano_dia FOR EACH STATEMENT EXECUTE FUNCTION ind_imutavel_trg();
CREATE TRIGGER jornada_card_checklist_muda AFTER UPDATE OF coluna ON public.jornada_card FOR EACH ROW WHEN ((old.coluna IS DISTINCT FROM new.coluna)) EXECUTE FUNCTION jornada_checklist_gatilho();
CREATE TRIGGER jornada_card_checklist_novo AFTER INSERT ON public.jornada_card FOR EACH ROW EXECUTE FUNCTION jornada_checklist_gatilho();
CREATE TRIGGER jornada_card_tr_upd AFTER UPDATE ON public.jornada_card REFERENCING OLD TABLE AS o NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION jornada_avisar_card_upd();
CREATE TRIGGER jornada_evento_imutavel BEFORE UPDATE ON public.jornada_evento FOR EACH ROW EXECUTE FUNCTION jornada_imutavel();
CREATE TRIGGER jornada_exame_conferir_ins AFTER INSERT ON public.jornada_exame REFERENCING NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION jornada_exame_conferir_ins();
CREATE TRIGGER jornada_exame_conferir_upd AFTER UPDATE ON public.jornada_exame REFERENCING OLD TABLE AS o NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION jornada_exame_conferir_upd();
CREATE TRIGGER jornada_exame_tr_ins AFTER INSERT ON public.jornada_exame REFERENCING NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION jornada_avisar_exame_ins();
CREATE TRIGGER jornada_exame_tr_upd AFTER UPDATE ON public.jornada_exame REFERENCING OLD TABLE AS o NEW TABLE AS n FOR EACH STATEMENT EXECUTE FUNCTION jornada_avisar_exame_upd();
CREATE TRIGGER jornada_mensagem_imutavel BEFORE UPDATE ON public.jornada_mensagem FOR EACH ROW EXECUTE FUNCTION jornada_imutavel();
CREATE TRIGGER mensagem_aguarda_paciente AFTER INSERT ON public.mensagens FOR EACH ROW EXECUTE FUNCTION mensagem_aguarda_paciente_trg();
CREATE TRIGGER mensagens_apos_insert AFTER INSERT ON public.mensagens FOR EACH ROW EXECUTE FUNCTION mensagem_inserida();
CREATE TRIGGER mensagens_chat_push AFTER INSERT ON public.mensagens FOR EACH ROW EXECUTE FUNCTION chat_push_trg();
CREATE TRIGGER mensagens_conferir_preco AFTER INSERT ON public.mensagens FOR EACH ROW EXECUTE FUNCTION mensagens_conferir_preco_trg();
CREATE TRIGGER mensagens_motor_fluxo AFTER INSERT ON public.mensagens FOR EACH ROW EXECUTE FUNCTION fluxo_mensagem_trg();
CREATE TRIGGER mensagens_zz_teste AFTER INSERT ON public.mensagens FOR EACH ROW EXECUTE FUNCTION mensagens_teste_trg();
CREATE TRIGGER org_alteracao_log_imutavel BEFORE DELETE OR UPDATE ON public.org_alteracao_log FOR EACH ROW EXECUTE FUNCTION org_log_imutavel_trg();
CREATE TRIGGER pessoa_klingo_vinculo_log AFTER INSERT OR DELETE OR UPDATE ON public.pessoa_klingo_vinculo FOR EACH ROW EXECUTE FUNCTION vinculo_log_trg();
CREATE TRIGGER agendamento_remarcacao_feita AFTER UPDATE OF status ON public.pre_agendamentos FOR EACH ROW EXECUTE FUNCTION agendamento_remarcacao_feita_trg();
CREATE TRIGGER ia_evento_pre AFTER INSERT OR UPDATE OF status, conferencia_status ON public.pre_agendamentos FOR EACH ROW EXECUTE FUNCTION ia_evento_trg();
CREATE TRIGGER pessoa_agrupar_pre AFTER INSERT OR UPDATE OF paciente ON public.pre_agendamentos FOR EACH ROW EXECUTE FUNCTION pessoa_agrupar_pre_trg();
CREATE TRIGGER pre_agendamento_historico AFTER UPDATE OF status ON public.pre_agendamentos FOR EACH ROW EXECUTE FUNCTION pre_agendamento_historico_trg();
CREATE TRIGGER pre_agendamento_valida_paciente AFTER UPDATE ON public.pre_agendamentos FOR EACH ROW EXECUTE FUNCTION pre_agendamento_valida_paciente_trg();
CREATE TRIGGER pre_agendamento_vincula_conta AFTER INSERT OR UPDATE OF paciente_id ON public.pre_agendamentos FOR EACH ROW EXECUTE FUNCTION pre_agendamento_vincula_conta_trg();
CREATE TRIGGER pre_agendamentos_zz_autoria BEFORE UPDATE OF status ON public.pre_agendamentos FOR EACH ROW EXECUTE FUNCTION pre_agendamento_autoria_trg();
CREATE TRIGGER registro_assinaturas_imutavel BEFORE DELETE OR UPDATE ON public.registro_assinaturas FOR EACH ROW EXECUTE FUNCTION registro_imutavel_trg();
CREATE TRIGGER registro_assinaturas_sem_truncate BEFORE TRUNCATE ON public.registro_assinaturas FOR EACH STATEMENT EXECUTE FUNCTION registro_imutavel_trg();
CREATE TRIGGER vinculo_log_imutavel BEFORE DELETE OR UPDATE ON public.vinculo_log FOR EACH ROW EXECUTE FUNCTION org_log_imutavel_trg();

-- ===== Tabelas publicadas no tempo real (postgres_changes) =====
-- public.atendimentos
-- public.conversas
-- public.fila_chegada
-- public.jornada_card
-- public.jornada_exame
-- public.jornada_mensagem
-- public.jornada_tarefa
-- public.mensagens

-- ===== Rotinas agendadas (pg_cron): 26 =====
-- agenda-conferir · 15 seconds · ativa
--   select net.http_post( url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo', headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')), body := '{"agenda":"conferir"}'::jsonb, timeout_milliseconds := 40000) where public.agenda_conferencia_ha_trabalho(false);
-- agenda-ocupacao · */10 8-23,0,1 * * * · ativa
--   select net.http_post( url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo', headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')), body := '{"agenda":"ocupacao"}'::jsonb, timeout_milliseconds := 120000);
-- agenda-ocupacao-noite · */30 2-7 * * * · ativa
--   select net.http_post( url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo', headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')), body := '{"agenda":"ocupacao"}'::jsonb, timeout_milliseconds := 120000);
-- agenda-revisar · */10 * * * * · ativa
--   select net.http_post( url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo', headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')), body := '{"agenda":"conferir","lento":true}'::jsonb, timeout_milliseconds := 100000) where public.agenda_conferencia_ha_trabalho(true);
-- agendado-vigia · */5 * * * * · ativa
--   select public.agendado_vigiar()
-- agendamento-klingo · */10 * * * * · ativa
--   select public.agendamento_conferir_klingo()
-- agendamento-reconhecer-klingo · 30 seconds · ativa
--   select public.agendamento_reconhecer_disparar()
-- autoencerrar-vigia · */5 * * * * · ativa
-- pedido-horario-vigia · */5 * * * * · ativa
--   select public.autoencerrar_vigiar()
-- catalogo-precos-convenio · 10 6 * * * · ativa
--   select net.http_post( url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo', headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')), body := '{"precos":"convenio"}'::jsonb, timeout_milliseconds := 150000);
-- catalogo-precos-particular · 25 6 * * * · ativa
--   select net.http_post( url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo', headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')), body := '{"precos":"particular"}'::jsonb, timeout_milliseconds := 150000);
-- chat-corpo-cache · */10 * * * * · ativa
--   select public.chat_corpo_atualizar()
-- convenios-revisar · 5 11 * * * · ativa
--   select public.convenios_revisar()
-- espera-vigia · * * * * * · ativa
--   select public.espera_vigiar()
-- fluxo-exames · 40 6 * * * · ativa
--   refresh materialized view concurrently public.fluxo_exames
-- indicadores-fechar-dia · 10 3 * * * · ativa
--   select public.ind_fechar_pendentes()
-- jornada-klingo-30s · 30 seconds · ativa
--   select public.jornada_klingo_agendar()
-- jornada-vigia · * * * * * · ativa
--   select public.jornada_vigiar()
-- klingo-ligar-pendentes · 4-59/10 * * * * · ativa
--   select public.paciente_klingo_ligar_pendentes()
-- manutencao-limpeza · 17 7 * * * · ativa
--   select public.manutencao_limpar()
-- pessoa-agrupar · */5 * * * * · ativa
--   select public.pessoa_agrupar_pendentes()
-- sync-catalogo-klingo · 0 6 * * * · ativa
--   select net.http_post( url := 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/sync-catalogo-klingo', headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-key', (select valor from public.config where chave = 'ia_segredo')), body := '{}'::jsonb, timeout_milliseconds := 120000);

-- klingo-autogestao · */10 * * * * · ativa
--   select public.klingo_autogestao()
-- klingo-limpeza · 27 7 * * * · ativa
--   select public.klingo_limpar()
-- klingo-operacao-vigia · * * * * * · ativa
--   select public.klingo_operacao_vigiar()
-- klingo-revisar-pacientes · */5 * * * * · ativa
--   select public.klingo_revisao_disparar()
-- klingo-sincronizar · 50 6 * * * · ativa
--   select public.klingo_sincronizar_disparar()

-- ===== Chaves existentes em public.config (só os nomes; os valores não são copiados) =====
-- agenda_ao_vivo, agenda_ao_vivo_max_dias, agenda_ao_vivo_trava_s, agenda_ao_vivo_validade_s, agendado_conferir_prazo_min, agendamento_reconhecer, agendamento_reconhecer_msg_encerradas, autoencerrar_horas, autoencerrar_modo, avaliacao_ativa, boas_vindas, cadastro_equipe_sem_convite, chat_push_url, checkin_sem_login_max_dia, convenio_suspenso_texto, despedida_configurada, despedida_inatividade_ativa, despedida_inatividade_texto, despedida_versao_atual, encerramento_exige_motivo, encerramento_valida_agendado, equipe_push_url, fila_autochegada, fila_aviso_antes, fila_push_url, fila_vapid_publica, horario_trabalho, ia_ativa, ia_segredo, indicadores_fechar, jornada_identidade_klingo, jornada_relatorio_filtro, jornada_relatorio_id, klingo_paciente_url, login_paciente, motor, motor_telefones_teste, nome_empresa, permissao_modo, previsao_texto, reabrir_dias, reaproveitar_cadastro_convidado, teste_agentes, teste_marcadores, vinculo_manual_quem, klingo_api_horarios, klingo_api_marcar, klingo_api_pre_cadastro, klingo_api_pos, klingo_api_telefones_teste, klingo_api_percentual, klingo_webhook, klingo_autogestao, klingo_funcoes_base, pedido_horario_modo, pedido_parado_horas, pedido_sem_horario_texto
