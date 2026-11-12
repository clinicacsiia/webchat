-- Autoatendimento com a API do Klingo — Parte 1: tabelas, interruptores e segredos. Escrito em 12/11/2026.
--
-- FLUXOGRAMA: o chat pede horários e marcação -> (1) klingo_oferta guarda o que a API do Klingo ofereceu a ESTA conversa; (2) klingo_operacao guarda cada escrita
--   no Klingo com chave única (duplo toque = 1 operação); (3) klingo_identidade guarda o CPF+nascimento já conferido na API (só hash, nunca o CPF);
--   (4) klingo_cota é o balde de chamadas por segundo que TODAS as funções dividem (a API responde 429 depois de ~14 chamadas seguidas);
--   (5) klingo_evento/klingo_medida guardam avisos do Klingo e as medidas que decidem sozinhas se a automação avança ou recua.
-- Versão 1.0 — 12/11/2026 / Mudança: primeira versão (planejamento de autoatendimento, etapas 0 a 5).
-- Todas as tabelas têm RLS ligada e NENHUMA regra de acesso: só service_role e funções security definer enxergam (nada de nome, CPF, telefone ou laudo aqui).
--
-- Para voltar atrás (não apaga nada do chat; só desliga e remove o que é novo):
--   update public.config set valor = 'nao' where chave in ('klingo_api_horarios','klingo_api_marcar','klingo_api_pre_cadastro','klingo_api_pos','klingo_webhook','klingo_autogestao');
--   -- e, se quiser apagar de vez: drop table public.klingo_operacao, klingo_oferta, klingo_identidade, klingo_evento, klingo_medida, klingo_cota,
--   --   klingo_convenio, klingo_plano_map, klingo_especialidade, klingo_proc_api cascade; alter table public.pre_agendamentos drop column agendado_origem;

-- Interruptores (tudo começa no modo mais seguro; a autogestão só avança quando as medidas permitem)
insert into public.config (chave, valor) values
  ('klingo_api_horarios', 'sombra'),         -- nao | sombra (a API roda em paralelo e só compara) | sim (o chat mostra horários reais)
  ('klingo_api_marcar', 'teste'),            -- nao | teste (só os telefones da lista) | sim (todos, respeitando o percentual)
  ('klingo_api_pre_cadastro', 'teste'),      -- paciente novo marca sozinho: nao | teste | sim
  ('klingo_api_pos', 'teste'),               -- ver, cancelar e remarcar pelo chat: nao | teste | sim
  ('klingo_api_telefones_teste', ''),        -- telefones (só números, separados por vírgula) que sempre usam a automação nos modos "teste"
  ('klingo_api_percentual', '100'),          -- no modo "sim": que parte das conversas usa a automação (0 a 100)
  ('klingo_webhook', 'nao'),                 -- sim = aplica os avisos que o Klingo manda
  ('klingo_autogestao', 'sim'),              -- sim = a rotina de medidas pode avançar ou recuar os interruptores acima
  ('klingo_funcoes_base', 'https://nrvuynjwcgwpjdptkiay.supabase.co/functions/v1/')
on conflict (chave) do nothing;

-- Cota global de chamadas ao Klingo (balde de fichas com reposição contínua)
create table if not exists public.klingo_cota (
  id boolean primary key default true check (id),
  fichas numeric not null default 10,
  max_fichas numeric not null default 10,
  reposicao_por_s numeric not null default 1,
  reposto_em timestamptz not null default clock_timestamp(),
  pausado_ate timestamptz,
  ultimo_429_em timestamptz
);
insert into public.klingo_cota (id) values (true) on conflict do nothing;

-- Convênios e planos do Klingo (copiados toda madrugada de GET /convenios)
create table if not exists public.klingo_convenio (
  plano_id integer primary key,
  convenio_id integer not null,
  convenio text not null,
  plano text not null,
  convenio_norm text not null,
  padrao boolean not null default false,       -- plano com o mesmo nome do convênio
  visto_em timestamptz not null default now()
);
create index if not exists klingo_convenio_conv_idx on public.klingo_convenio (convenio_id);

-- Tradução do convênio do chat (texto) para o convênio e plano do Klingo (números). Preenchida sozinha; a equipe só revisa se quiser.
create table if not exists public.klingo_plano_map (
  operadora text primary key,
  convenio_id integer,
  plano_id integer,                             -- plano padrão; nulo = usar o plano que o paciente já tem no cadastro do Klingo
  origem text not null check (origem in ('auto', 'manual', 'nao_atende')),
  atualizado_em timestamptz not null default now()
);

-- Especialidades que a API oferece (GET /agenda/especialidades + /agenda/consultas)
create table if not exists public.klingo_especialidade (
  cbos text primary key,
  nome text not null,
  codigo text,
  procedimentos integer[] not null default '{}',
  liberada_api boolean not null default true,
  atualizado_em timestamptz not null default now()
);

-- Procedimentos (exames) que a API já mostrou ter horário: aprende sozinho
create table if not exists public.klingo_proc_api (
  procedimento_id integer primary key,
  com_horario_em timestamptz,
  vazio_em timestamptz
);

-- Identidade conferida na API (CPF + nascimento): só hashes
create table if not exists public.klingo_identidade (
  id uuid primary key default gen_random_uuid(),
  chave text not null unique,                   -- hmac(cpf|nascimento)
  cpf_hash text not null,                       -- hmac(cpf): trava de pré-cadastro único por CPF
  tipo text check (tipo in ('definitivo', 'pre')),
  klingo_id text,                               -- definitivo = "P123"; pré-cadastro = "123" (NUNCA misturar: o login com P abre outro paciente)
  situacao text not null check (situacao in ('confere', 'divergente', 'nao_encontrado', 'sem_id_definitivo', 'erro', 'pre_cadastro')),
  faltando text[] not null default '{}',
  plano_id integer,                             -- plano que o paciente tem no cadastro do Klingo
  conferido_em timestamptz not null default now(),
  convertido_em timestamptz,
  criado_pela_operacao uuid,
  constraint klingo_identidade_id_ck check (klingo_id is null or (tipo = 'definitivo' and klingo_id ~ '^P[0-9]+$') or (tipo = 'pre' and klingo_id ~ '^[0-9]+$'))
);
create unique index if not exists klingo_identidade_pre_uq on public.klingo_identidade (cpf_hash) where tipo = 'pre';
create index if not exists klingo_identidade_cpf_idx on public.klingo_identidade (cpf_hash);

-- Horários que a API ofereceu a uma conversa (o servidor lembra o que ofereceu: o chat só escolhe entre estes)
create table if not exists public.klingo_oferta (
  id bigint generated always as identity primary key,
  conversa_id uuid not null references public.conversas (id) on delete cascade,
  chave text not null,                          -- data|médico|agenda|unidade|hora
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
create index if not exists klingo_oferta_exp_idx on public.klingo_oferta (expira_em);

-- Toda escrita no Klingo é uma operação: idempotente, auditável e sem dado pessoal
create table if not exists public.klingo_operacao (
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
  codigo text,                                  -- código interno do motivo (nunca o corpo da resposta do Klingo)
  detalhe jsonb not null default '{}'::jsonb,   -- data, hora, procedimento, plano, oferta, tipo de identidade (sem nome, CPF ou telefone)
  origem text not null default 'chat' check (origem in ('chat', 'equipe', 'sistema')),
  criado_em timestamptz not null default now(),
  iniciado_em timestamptz,
  concluido_em timestamptz
);
create index if not exists klingo_operacao_conv_idx on public.klingo_operacao (conversa_id, criado_em desc);
create index if not exists klingo_operacao_estado_idx on public.klingo_operacao (estado, criado_em);

-- Avisos do Klingo (webhook)
create table if not exists public.klingo_evento (
  id bigint generated always as identity primary key,
  hash text not null unique,
  evento text,
  id_marcacao text,
  status text,
  recebido_em timestamptz not null default now(),
  processado_em timestamptz,
  resultado text
);

-- Medidas diárias (contagem e soma de milissegundos) para a autogestão e para os indicadores
create table if not exists public.klingo_medida (
  dia date not null,
  tipo text not null,
  n bigint not null default 0,
  soma_ms bigint not null default 0,
  primary key (dia, tipo)
);

alter table public.klingo_cota enable row level security;
alter table public.klingo_convenio enable row level security;
alter table public.klingo_plano_map enable row level security;
alter table public.klingo_especialidade enable row level security;
alter table public.klingo_proc_api enable row level security;
alter table public.klingo_identidade enable row level security;
alter table public.klingo_oferta enable row level security;
alter table public.klingo_operacao enable row level security;
alter table public.klingo_evento enable row level security;
alter table public.klingo_medida enable row level security;

-- De onde veio o "agendado": equipe | reconhecido (casado por relatório) | chat_api (marcado sozinho pela API)
alter table public.pre_agendamentos add column if not exists agendado_origem text;
alter table public.pre_agendamentos drop constraint if exists pre_agendamentos_agendado_origem_ck;
alter table public.pre_agendamentos add constraint pre_agendamentos_agendado_origem_ck check (agendado_origem is null or agendado_origem in ('equipe', 'reconhecido', 'chat_api'));
