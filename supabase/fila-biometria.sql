-- FLUXOGRAMA: entrada (fila_inserir e fila_chamar_assinatura pela recepção; Python grava a assinatura) -> validação (papel_atual, claim atendimento_id do JWT, máquina de estados, hash do documento) -> lógica (RLS por claim, trigger de transição, registro imutável) -> saída (atendimentos, registro_assinaturas, broadcast fila_mudou em fila:global sem dado pessoal)
-- Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
-- Módulo: Fila virtual em tempo real + coleta de assinatura biométrica dinâmica.
-- Projeto: webchat-atendimento (nrvuynjwcgwpjdptkiay). Aditivo e idempotente: pode rodar de novo.
-- Pré-requisito: supabase/pacientes.sql, supabase/00-base-snapshot.sql (papel_atual) e o publication supabase_realtime.
-- Sem comandos destrutivos sobre dados (nenhum drop table, delete ou truncate de tabela existente).

-- ============================================================
-- 1) pacientes: campos do módulo, sem recriar a tabela
-- ============================================================
-- email_cadastro é coluna gerada a partir de pacientes.email (minúsculas): o e-mail não é duplicado.
alter table public.pacientes add column if not exists email_cadastro text generated always as (lower(email)) stored;
alter table public.pacientes add column if not exists perfil_biometrico_historico jsonb not null default '{}'::jsonb;
alter table public.pacientes add column if not exists assinatura_papel_path text;

comment on column public.pacientes.perfil_biometrico_historico is 'Média e variância (EWMA) das características dinâmicas da assinatura. Dado biométrico sensível (LGPD, art. 11). Só a API Python lê e grava; a equipe e o navegador não têm grant nesta coluna.';
comment on column public.pacientes.assinatura_papel_path is 'Caminho, no Storage privado, da assinatura de papel digitalizada (opcional).';

-- REVOKE de coluna não funciona enquanto existir grant de tabela. Por isso a tabela inteira sai do papel
-- authenticated/anon e volta só com as colunas listadas. Nenhuma tela do repositório lê pacientes direto (verificado).
revoke select, update on public.pacientes from anon, authenticated;
grant select (id, nome, nome_norm, telefones, email, email_cadastro, dt_nasc, cpf, dados, validado, validado_em,
              revisar, origem_conversa, criado_em, atualizado_em, ultima_visita_em, assinatura_papel_path)
  on public.pacientes to authenticated;
grant update (nome, nome_norm, telefones, email, dt_nasc, cpf, dados, validado, validado_em, revisar,
              origem_conversa, atualizado_em, ultima_visita_em, assinatura_papel_path)
  on public.pacientes to authenticated;

-- ============================================================
-- 2) atendimentos: fila e máquina de estados
-- ============================================================
create table if not exists public.atendimentos (
  id uuid primary key default gen_random_uuid(),
  paciente_id uuid not null references public.pacientes(id) on delete restrict,
  status text not null default 'aguardando'
    check (status in ('aguardando', 'assinatura_pendente', 'em_atendimento', 'concluido')),
  documento_texto text check (char_length(documento_texto) between 20 and 20000),
  documento_hash text check (documento_hash ~ '^[0-9a-f]{64}$'),
  tentativas_falhas smallint not null default 0 check (tentativas_falhas between 0 and 3),
  bloqueado_em timestamptz,
  created_at timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint atendimentos_assinatura_completa
    check (status <> 'assinatura_pendente' or (documento_texto is not null and documento_hash is not null)),
  constraint atendimentos_bloqueio_coerente
    check (bloqueado_em is null or (status = 'assinatura_pendente' and tentativas_falhas = 3))
);
comment on table public.atendimentos is 'Fila da recepção. Uma linha por visita. Paciente lê só a própria linha (claim atendimento_id do JWT). Escrita só por funções fila_* (equipe) e pela API Python (assinatura).';

create index if not exists atendimentos_fila_idx on public.atendimentos (created_at, id) where status = 'aguardando';
create unique index if not exists atendimentos_um_aberto_por_paciente on public.atendimentos (paciente_id) where status <> 'concluido';

-- Transições permitidas. Qualquer outra muda o status com erro, mesmo vinda de SQL direto.
create or replace function public.atendimentos_transicao_trg() returns trigger language plpgsql set search_path to '' as $$
begin
  if new.status is distinct from old.status and not (
       (old.status = 'aguardando'          and new.status = 'assinatura_pendente')
    or (old.status = 'assinatura_pendente' and new.status in ('aguardando', 'em_atendimento'))
    or (old.status = 'em_atendimento'      and new.status = 'concluido')
  ) then
    raise exception 'Transição de status não permitida: % -> %.', old.status, new.status using errcode = 'P0001';
  end if;
  if old.status in ('em_atendimento', 'concluido')
     and (new.documento_hash is distinct from old.documento_hash or new.documento_texto is distinct from old.documento_texto) then
    raise exception 'Documento de atendimento já assinado não pode ser alterado.' using errcode = 'P0001';
  end if;
  new.atualizado_em := now();
  return new;
end $$;

drop trigger if exists atendimentos_transicao on public.atendimentos;
create trigger atendimentos_transicao before update on public.atendimentos
  for each row execute function public.atendimentos_transicao_trg();

-- ============================================================
-- 3) Registro de assinatura (imutável) e log de tentativas falhas (imutável)
-- ============================================================
create table if not exists public.registro_assinaturas (
  id uuid primary key default gen_random_uuid(),
  atendimento_id uuid not null unique references public.atendimentos(id) on delete restrict,
  email_confirmado_transacao text not null,   -- vem do claim email_informado do JWT assinado, nunca do corpo da requisição
  hash_documento text not null check (hash_documento ~ '^[0-9a-f]{64}$'),
  consentimento_biometrico boolean not null check (consentimento_biometrico),
  tipo_validacao text not null check (tipo_validacao in ('enrolamento', 'comparacao')),
  score_similaridade numeric(5,4),
  vetor_traco_bruto jsonb not null,            -- série temporal enviada pelo Canvas
  caracteristicas jsonb not null,              -- features extraídas no servidor
  ip_origem text,
  user_agent text not null check (char_length(user_agent) <= 500),
  created_at timestamptz not null default now(),
  constraint registro_score_coerente check (
    (tipo_validacao = 'enrolamento' and score_similaridade is null)
    or (tipo_validacao = 'comparacao' and score_similaridade is not null))
);
comment on table public.registro_assinaturas is 'Lastro jurídico da assinatura. Imutável: UPDATE, DELETE e TRUNCATE são bloqueados por trigger. Só admin lê.';

create table if not exists public.assinatura_tentativas (
  id bigint generated always as identity primary key,
  atendimento_id uuid not null references public.atendimentos(id) on delete restrict,
  numero smallint not null check (numero between 1 and 3),
  score_similaridade numeric(5,4) not null,
  ip_origem text,
  user_agent text,
  created_at timestamptz not null default now(),
  unique (atendimento_id, numero)
);
comment on table public.assinatura_tentativas is 'Tentativas reprovadas (score < 0.30). Imutável. O score nunca é devolvido ao paciente.';

create or replace function public.registro_imutavel_trg() returns trigger language plpgsql set search_path to '' as $$
begin
  raise exception 'Tabela % é imutável: não aceita alteração nem exclusão.', tg_table_name using errcode = 'P0001';
end $$;

drop trigger if exists registro_assinaturas_imutavel on public.registro_assinaturas;
create trigger registro_assinaturas_imutavel before update or delete on public.registro_assinaturas
  for each row execute function public.registro_imutavel_trg();
drop trigger if exists registro_assinaturas_sem_truncate on public.registro_assinaturas;
create trigger registro_assinaturas_sem_truncate before truncate on public.registro_assinaturas
  for each statement execute function public.registro_imutavel_trg();
drop trigger if exists assinatura_tentativas_imutavel on public.assinatura_tentativas;
create trigger assinatura_tentativas_imutavel before update or delete on public.assinatura_tentativas
  for each row execute function public.registro_imutavel_trg();
drop trigger if exists assinatura_tentativas_sem_truncate on public.assinatura_tentativas;
create trigger assinatura_tentativas_sem_truncate before truncate on public.assinatura_tentativas
  for each statement execute function public.registro_imutavel_trg();

-- ============================================================
-- 4) RLS: o paciente vê só a própria linha (claim atendimento_id do JWT)
-- ============================================================
alter table public.atendimentos enable row level security;
alter table public.registro_assinaturas enable row level security;
alter table public.assinatura_tentativas enable row level security;

revoke all on public.atendimentos, public.registro_assinaturas, public.assinatura_tentativas from anon, authenticated;
grant select on public.atendimentos to authenticated;
grant select on public.registro_assinaturas, public.assinatura_tentativas to authenticated;

drop policy if exists atendimentos_paciente_select on public.atendimentos;
create policy atendimentos_paciente_select on public.atendimentos for select to authenticated
  using (id = nullif((select auth.jwt()) ->> 'atendimento_id', '')::uuid);

drop policy if exists atendimentos_equipe_select on public.atendimentos;
create policy atendimentos_equipe_select on public.atendimentos for select to authenticated
  using ((select public.papel_atual()) in ('admin', 'atendente'));

drop policy if exists registro_assinaturas_admin on public.registro_assinaturas;
create policy registro_assinaturas_admin on public.registro_assinaturas for select to authenticated
  using ((select public.papel_atual()) = 'admin');

drop policy if exists assinatura_tentativas_admin on public.assinatura_tentativas;
create policy assinatura_tentativas_admin on public.assinatura_tentativas for select to authenticated
  using ((select public.papel_atual()) = 'admin');

-- ============================================================
-- 5) Funções da equipe (recepção): sempre com checagem de papel
-- ============================================================
create or replace function public.fila_exige_staff() returns void language plpgsql stable set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()) in ('admin', 'atendente'), false) is false then
    raise exception 'Sem permissão para a fila.' using errcode = '42501';
  end if;
end $$;
revoke all on function public.fila_exige_staff() from public, anon, authenticated;

create or replace function public.fila_inserir(p_paciente uuid) returns uuid language plpgsql security definer set search_path to '' as $$
declare
  v_id uuid;
begin
  perform public.fila_exige_staff();
  if not exists (select 1 from public.pacientes where id = p_paciente) then
    raise exception 'Paciente não encontrado.' using errcode = 'P0002';
  end if;
  insert into public.atendimentos (paciente_id) values (p_paciente) returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'Este paciente já está na fila ou em atendimento.' using errcode = '23505';
end $$;

-- Recepção envia o documento para assinatura. O hash é calculado aqui, sobre o texto gravado.
create or replace function public.fila_chamar_assinatura(p_atendimento uuid, p_texto text) returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.fila_exige_staff();
  if p_texto is null or char_length(p_texto) not between 20 and 20000 then
    raise exception 'Texto do documento inválido (entre 20 e 20.000 caracteres).' using errcode = '22023';
  end if;
  update public.atendimentos
     set status = 'assinatura_pendente',
         documento_texto = p_texto,
         documento_hash = encode(sha256(convert_to(p_texto, 'UTF8')), 'hex'),
         tentativas_falhas = 0,
         bloqueado_em = null
   where id = p_atendimento and status = 'aguardando';
  if not found then
    raise exception 'Atendimento não está aguardando na fila.' using errcode = 'P0001';
  end if;
end $$;

-- Cancela o envio ou desfaz o bloqueio. O paciente volta para a fila na mesma posição (created_at não muda).
create or replace function public.fila_cancelar_assinatura(p_atendimento uuid) returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.fila_exige_staff();
  update public.atendimentos
     set status = 'aguardando', documento_texto = null, documento_hash = null,
         tentativas_falhas = 0, bloqueado_em = null
   where id = p_atendimento and status = 'assinatura_pendente';
  if not found then
    raise exception 'Atendimento não está aguardando assinatura.' using errcode = 'P0001';
  end if;
end $$;

create or replace function public.fila_concluir(p_atendimento uuid) returns void language plpgsql security definer set search_path to '' as $$
begin
  perform public.fila_exige_staff();
  update public.atendimentos set status = 'concluido' where id = p_atendimento and status = 'em_atendimento';
  if not found then
    raise exception 'Atendimento não está em atendimento.' using errcode = 'P0001';
  end if;
end $$;

revoke all on function public.fila_inserir(uuid), public.fila_chamar_assinatura(uuid, text),
  public.fila_cancelar_assinatura(uuid), public.fila_concluir(uuid) from public, anon;
grant execute on function public.fila_inserir(uuid), public.fila_chamar_assinatura(uuid, text),
  public.fila_cancelar_assinatura(uuid), public.fila_concluir(uuid) to authenticated;

-- ============================================================
-- 6) Posição do paciente: devolve só números, nunca dados de outros pacientes
-- ============================================================
create or replace function public.fila_minha_posicao() returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare
  v_id uuid := nullif((select auth.jwt()) ->> 'atendimento_id', '')::uuid;
  v_status text;
  v_criado timestamptz;
  v_a_frente integer := null;
  v_aguardando integer;
begin
  if v_id is null then
    raise exception 'Link inválido.' using errcode = '28000';
  end if;
  select a.status, a.created_at into v_status, v_criado from public.atendimentos a where a.id = v_id;
  if not found then
    raise exception 'Atendimento não encontrado.' using errcode = 'P0002';
  end if;
  select count(*) into v_aguardando from public.atendimentos where status = 'aguardando';
  if v_status = 'aguardando' then
    select count(*) into v_a_frente from public.atendimentos a
     where a.status = 'aguardando' and (a.created_at, a.id) < (v_criado, v_id);
  end if;
  return jsonb_build_object('status', v_status, 'a_frente', v_a_frente, 'aguardando', v_aguardando);
end $$;

revoke all on function public.fila_minha_posicao() from public, anon;
grant execute on function public.fila_minha_posicao() to authenticated;

-- ============================================================
-- 7) Realtime: postgres_changes para a própria linha; broadcast privado para a fila
-- ============================================================
do $$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'atendimentos') then
    alter publication supabase_realtime add table public.atendimentos;
  end if;
end $$;

-- Aviso sem dado pessoal: só "a fila mudou". O paciente recalcula a própria posição com fila_minha_posicao().
create or replace function public.fila_avisar_trg() returns trigger language plpgsql security definer set search_path to '' as $$
begin
  perform realtime.send(jsonb_build_object('evento', 'fila_mudou'), 'fila_mudou', 'fila:global', true);
  return null;
exception when others then
  raise warning 'fila_avisar_trg: %', sqlerrm;   -- falha no aviso nunca bloqueia a gravação do atendimento
  return null;
end $$;

drop trigger if exists atendimentos_fila_avisar on public.atendimentos;
create trigger atendimentos_fila_avisar after insert or update of status or delete on public.atendimentos
  for each row execute function public.fila_avisar_trg();

drop policy if exists fila_paciente_recebe on realtime.messages;
create policy fila_paciente_recebe on realtime.messages for select to authenticated
  using (
    extension = 'broadcast'
    and (select realtime.topic()) = 'fila:global'
    and (select auth.jwt() ->> 'atendimento_id') is not null
  );
