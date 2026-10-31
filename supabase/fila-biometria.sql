-- FLUXOGRAMA: entrada (painel da recepção via fila_*; n8n via RPC com segredo; paciente via fila_estado com o token do link) -> validação (papel_atual, segredo do n8n no Vault, JWT HS256 verificado no banco, máquina de estados, hash do documento) -> lógica (RLS por token no cabeçalho, trava de linha, 3 tentativas no banco, registro imutável) -> saída (atendimentos, registro_assinaturas, broadcast privado fila_mudou/status sem dado pessoal, webhook do n8n por pg_net)
-- Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
-- Módulo: fila virtual em tempo real + coleta de assinatura biométrica dinâmica.
-- Projeto: webchat-atendimento (nrvuynjwcgwpjdptkiay). Aditivo e idempotente: pode rodar de novo.
-- Pré-requisitos: supabase/pacientes.sql, 00-base-snapshot.sql (papel_atual, config), extensões pgcrypto, supabase_vault e pg_net.
-- Sem comandos destrutivos sobre dados existentes. Nenhum segredo neste arquivo: fila_jwt_secret e fila_segredo são criados no Vault, fora do repositório.
--
-- Por que o token é assinado e verificado aqui, e não pelo JWT do projeto:
-- o PostgREST só aceita JWT assinado com a chave do projeto, que o n8n não tem. O token continua sendo um JWT HS256
-- com o payload pedido ({atendimento_id, email_informado, exp}), mas o segredo (fila_jwt_secret) nasce e fica no Vault.
-- O n8n pede a assinatura por RPC (fila_emitir_token) e só envia o e-mail.
--
-- O segredo do n8n (Vault: fila_segredo) chega no cabeçalho HTTP x-fila-segredo, vindo de uma credencial Header Auth
-- do n8n. Ele nunca é parâmetro de função nem fica escrito em workflow ou arquivo do repositório.

-- ============================================================
-- 1) pacientes: campos do módulo, sem recriar a tabela
-- ============================================================
-- email_cadastro é coluna gerada a partir de pacientes.email (minúsculas): o e-mail não é duplicado.
alter table public.pacientes add column if not exists email_cadastro text generated always as (lower(email)) stored;
alter table public.pacientes add column if not exists perfil_biometrico_historico jsonb not null default '{}'::jsonb;
alter table public.pacientes add column if not exists assinatura_papel_path text;

comment on column public.pacientes.perfil_biometrico_historico is 'Média e variância (EWMA) das características dinâmicas da assinatura. Dado biométrico sensível (LGPD, art. 11). Só as funções assinatura_* (segredo do n8n) leem e gravam; equipe e navegador não têm grant nesta coluna.';
comment on column public.pacientes.assinatura_papel_path is 'Caminho, no Storage privado, da assinatura de papel digitalizada (opcional).';

-- REVOKE de coluna não vale enquanto existir grant de tabela. Por isso a tabela sai do papel authenticated/anon
-- e volta só com as colunas listadas. Nenhuma tela nem função invoker do projeto lê pacientes direto (verificado).
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
  email_informado text not null
    check (char_length(email_informado) <= 200 and email_informado ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  status text not null default 'aguardando'
    check (status in ('aguardando', 'assinatura_pendente', 'em_atendimento', 'concluido')),
  documento_texto text check (char_length(documento_texto) between 20 and 20000),
  documento_hash text check (documento_hash ~ '^[0-9a-f]{64}$'),
  tentativas_falhas smallint not null default 0 check (tentativas_falhas between 0 and 3),
  bloqueado_em timestamptz,
  links_enviados smallint not null default 0 check (links_enviados between 0 and 10),
  created_at timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint atendimentos_assinatura_completa
    check (status <> 'assinatura_pendente' or (documento_texto is not null and documento_hash is not null)),
  constraint atendimentos_bloqueio_coerente
    check (bloqueado_em is null or (status = 'assinatura_pendente' and tentativas_falhas = 3))
);
comment on table public.atendimentos is 'Fila da recepção. Uma linha por visita. Escrita só por funções fila_* (equipe) e assinatura_* (n8n com segredo). O paciente lê só a própria linha, pelo token do link.';
comment on column public.atendimentos.email_informado is 'E-mail digitado na recepção. É o destino do link e entra no JWT; vira email_confirmado_transacao na assinatura.';

create index if not exists atendimentos_fila_idx on public.atendimentos (created_at, id) where status = 'aguardando';
create unique index if not exists atendimentos_um_aberto_por_paciente on public.atendimentos (paciente_id) where status <> 'concluido';

-- Transições permitidas. Qualquer outra falha, mesmo vinda de SQL direto.
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

create or replace trigger atendimentos_transicao before update on public.atendimentos
  for each row execute function public.atendimentos_transicao_trg();
revoke all on function public.atendimentos_transicao_trg() from public, anon, authenticated;   -- gatilho não é API

-- ============================================================
-- 3) Registro de assinatura (imutável) e log de tentativas reprovadas (imutável)
-- ============================================================
create table if not exists public.registro_assinaturas (
  id uuid primary key default gen_random_uuid(),
  atendimento_id uuid not null unique references public.atendimentos(id) on delete restrict,
  email_confirmado_transacao text not null,   -- claim email_informado do JWT verificado, nunca o corpo da requisição
  hash_documento text not null check (hash_documento ~ '^[0-9a-f]{64}$'),
  consentimento_biometrico boolean not null check (consentimento_biometrico),
  tipo_validacao text not null check (tipo_validacao in ('enrolamento', 'comparacao')),
  score_similaridade numeric(5,4),
  vetor_traco_bruto jsonb not null,            -- série temporal enviada pelo Canvas
  caracteristicas jsonb not null,              -- features extraídas pelo Python
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
comment on table public.assinatura_tentativas is 'Tentativas reprovadas (score abaixo de 0,30). Imutável. O score nunca é devolvido ao paciente.';

create or replace function public.registro_imutavel_trg() returns trigger language plpgsql set search_path to '' as $$
begin
  raise exception 'Tabela % é imutável: não aceita alteração nem exclusão.', tg_table_name using errcode = 'P0001';
end $$;

create or replace trigger registro_assinaturas_imutavel before update or delete on public.registro_assinaturas
  for each row execute function public.registro_imutavel_trg();
create or replace trigger registro_assinaturas_sem_truncate before truncate on public.registro_assinaturas
  for each statement execute function public.registro_imutavel_trg();
create or replace trigger assinatura_tentativas_imutavel before update or delete on public.assinatura_tentativas
  for each row execute function public.registro_imutavel_trg();
create or replace trigger assinatura_tentativas_sem_truncate before truncate on public.assinatura_tentativas
  for each statement execute function public.registro_imutavel_trg();
revoke all on function public.registro_imutavel_trg() from public, anon, authenticated;

-- ============================================================
-- 4) Token do link: JWT HS256 assinado e verificado aqui, segredo no Vault
-- ============================================================
create or replace function public.fila_segredo_vault(p_nome text) returns text
language sql stable security definer set search_path to '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_nome limit 1
$$;

create or replace function public.fila_segredo_ok(p_segredo text) returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce(p_segredo <> '' and p_segredo = public.fila_segredo_vault('fila_segredo'), false)
$$;

-- Segredo do n8n vindo do cabeçalho x-fila-segredo (PostgREST expõe os cabeçalhos em request.headers).
create or replace function public.fila_segredo_do_cabecalho() returns text
language plpgsql stable set search_path to '' as $$
begin
  return nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-fila-segredo';
exception when others then
  return null;
end $$;

create or replace function public.fila_n8n_autorizado() returns boolean
language sql stable security definer set search_path to '' as $$
  select public.fila_segredo_ok(public.fila_segredo_do_cabecalho())
$$;

create or replace function public.fila_b64url(p bytea) returns text
language sql immutable set search_path to '' as $$
  select translate(replace(encode(p, 'base64'), E'\n', ''), '+/=', '-_')
$$;

create or replace function public.fila_b64url_decode(p text) returns bytea
language sql immutable set search_path to '' as $$
  select decode(translate(p, '-_', '+/') || repeat('=', (4 - length(p) % 4) % 4), 'base64')
$$;

create or replace function public.fila_jwt_assinar(p_claims jsonb) returns text
language plpgsql stable security definer set search_path to '' as $$
declare
  v_segredo text := public.fila_segredo_vault('fila_jwt_secret');
  v_h text;
  v_p text;
begin
  if v_segredo is null then
    raise exception 'Segredo do token não configurado no Vault (fila_jwt_secret).' using errcode = 'P0001';
  end if;
  v_h := public.fila_b64url(convert_to('{"alg":"HS256","typ":"JWT"}', 'UTF8'));
  v_p := public.fila_b64url(convert_to(p_claims::text, 'UTF8'));
  return v_h || '.' || v_p || '.' ||
    public.fila_b64url(extensions.hmac(convert_to(v_h || '.' || v_p, 'UTF8'), convert_to(v_segredo, 'UTF8'), 'sha256'));
end $$;

-- Devolve as claims se a assinatura, o alg, a audiência e a validade estiverem corretos; senão null (nunca lança).
create or replace function public.fila_jwt_validar(p_token text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_segredo text;
  v_partes text[];
  v_esperada text;
  v_claims jsonb;
begin
  if p_token is null or length(p_token) > 2000 then return null; end if;
  v_partes := string_to_array(p_token, '.');
  if array_length(v_partes, 1) is distinct from 3 then return null; end if;
  v_segredo := public.fila_segredo_vault('fila_jwt_secret');
  if v_segredo is null then return null; end if;
  v_esperada := public.fila_b64url(
    extensions.hmac(convert_to(v_partes[1] || '.' || v_partes[2], 'UTF8'), convert_to(v_segredo, 'UTF8'), 'sha256'));
  if v_esperada is distinct from v_partes[3] then return null; end if;
  if convert_from(public.fila_b64url_decode(v_partes[1]), 'UTF8')::jsonb ->> 'alg' is distinct from 'HS256' then return null; end if;
  v_claims := convert_from(public.fila_b64url_decode(v_partes[2]), 'UTF8')::jsonb;
  if v_claims ->> 'aud' is distinct from 'fila' then return null; end if;
  if (v_claims ->> 'exp')::bigint <= floor(extract(epoch from now()))::bigint then return null; end if;
  if nullif(v_claims ->> 'atendimento_id', '')::uuid is null then return null; end if;
  return v_claims;
exception when others then
  return null;
end $$;

create or replace function public.fila_atendimento_de(p_token text) returns uuid
language sql stable security definer set search_path to '' as $$
  select nullif(public.fila_jwt_validar(p_token) ->> 'atendimento_id', '')::uuid
$$;

-- Token no cabeçalho x-fila-token de uma requisição REST direta (PostgREST expõe os cabeçalhos em request.headers).
create or replace function public.fila_atendimento_do_cabecalho() returns uuid
language plpgsql stable security definer set search_path to '' as $$
begin
  return public.fila_atendimento_de(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-fila-token');
exception when others then
  return null;
end $$;

revoke all on function public.fila_segredo_do_cabecalho(), public.fila_n8n_autorizado() from public, anon, authenticated;
revoke all on function public.fila_segredo_vault(text), public.fila_segredo_ok(text), public.fila_b64url(bytea),
  public.fila_b64url_decode(text), public.fila_jwt_assinar(jsonb), public.fila_jwt_validar(text),
  public.fila_atendimento_de(text) from public, anon, authenticated;
revoke all on function public.fila_atendimento_do_cabecalho() from public, anon, authenticated;
grant execute on function public.fila_atendimento_do_cabecalho() to anon, authenticated;

-- ============================================================
-- 5) RLS: paciente lê só a própria linha (token no cabeçalho); equipe lê tudo
-- ============================================================
alter table public.atendimentos enable row level security;
alter table public.registro_assinaturas enable row level security;
alter table public.assinatura_tentativas enable row level security;

revoke all on public.atendimentos, public.registro_assinaturas, public.assinatura_tentativas from anon, authenticated;
grant select on public.atendimentos to authenticated;
grant select (id, status, documento_texto, tentativas_falhas, bloqueado_em, created_at) on public.atendimentos to anon;
grant select on public.registro_assinaturas, public.assinatura_tentativas to authenticated;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'atendimentos' and policyname = 'atendimentos_paciente_token') then
    create policy atendimentos_paciente_token on public.atendimentos for select to anon
      using (id = (select public.fila_atendimento_do_cabecalho()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'atendimentos' and policyname = 'atendimentos_equipe_select') then
    create policy atendimentos_equipe_select on public.atendimentos for select to authenticated
      using ((select public.papel_atual()) in ('admin', 'atendente'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'registro_assinaturas' and policyname = 'registro_assinaturas_admin') then
    create policy registro_assinaturas_admin on public.registro_assinaturas for select to authenticated
      using ((select public.papel_atual()) = 'admin');
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'assinatura_tentativas' and policyname = 'assinatura_tentativas_admin') then
    create policy assinatura_tentativas_admin on public.assinatura_tentativas for select to authenticated
      using ((select public.papel_atual()) = 'admin');
  end if;
end $$;

-- ============================================================
-- 6) Recepção (painel, sessão de atendente ou admin)
-- ============================================================
create or replace function public.fila_exige_staff() returns void language plpgsql stable set search_path to '' as $$
begin
  if coalesce((select public.papel_atual()) in ('admin', 'atendente'), false) is false then
    raise exception 'Sem permissão para a fila.' using errcode = '42501';
  end if;
end $$;
revoke all on function public.fila_exige_staff() from public, anon, authenticated;

-- Aviso ao n8n (pg_net, assíncrono, depois do commit). O n8n só recebe o id: nome e e-mail ele busca com o segredo.
create or replace function public.fila_avisar_n8n(p_atendimento uuid) returns void
language plpgsql security definer set search_path to '' as $$
declare
  v_url text;
  a public.atendimentos%rowtype;
  v_nome text;
begin
  select valor into v_url from public.config where chave = 'fila_webhook_url';
  if coalesce(v_url, '') = '' then return; end if;
  select * into a from public.atendimentos where id = p_atendimento;
  if not found then return; end if;
  select nome into v_nome from public.pacientes where id = a.paciente_id;
  begin
    perform net.http_post(
      url := v_url,
      body := jsonb_build_object('nome', v_nome, 'email_informado', a.email_informado,
                                 'paciente_id', a.paciente_id, 'atendimento_uuid', a.id),
      headers := '{"Content-Type":"application/json"}'::jsonb);
  exception when others then
    raise warning 'fila_avisar_n8n: %', sqlerrm;   -- falha de rede nunca desfaz a entrada na fila
  end;
end $$;
revoke all on function public.fila_avisar_n8n(uuid) from public, anon, authenticated;

-- Entra na fila: acha o paciente pelo e-mail + nome (ou cria) e dispara o link.
create or replace function public.fila_entrar(p_nome text, p_email text, p_telefone text default null) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_nome text := btrim(coalesce(p_nome, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_paciente uuid;
  v_atendimento uuid;
  v_fone text := public.fone_chave(p_telefone);
  v_ativo boolean := coalesce((select valor from public.config where chave = 'fila_webhook_url'), '') <> '';
begin
  perform public.fila_exige_staff();
  if char_length(v_nome) not between 3 and 120 then
    raise exception 'Informe o nome completo do paciente.' using errcode = '22023';
  end if;
  if char_length(v_email) > 200 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'E-mail inválido.' using errcode = '22023';
  end if;

  select p.id into v_paciente from public.pacientes p
   where lower(p.email) = v_email and public.nome_confere(p.nome, v_nome)
   order by p.ultima_visita_em desc limit 1;

  if v_paciente is null then
    insert into public.pacientes (nome, nome_norm, telefones, email)
    values (v_nome, coalesce(public.norm_nome(v_nome), upper(v_nome)),
            case when v_fone is null then '{}'::text[] else array[v_fone] end, v_email)
    returning id into v_paciente;
  else
    update public.pacientes set ultima_visita_em = now(), atualizado_em = now(),
           telefones = case when v_fone is null or v_fone = any(telefones) then telefones else telefones || v_fone end
     where id = v_paciente;
  end if;

  begin
    insert into public.atendimentos (paciente_id, email_informado) values (v_paciente, v_email) returning id into v_atendimento;
  exception when unique_violation then
    raise exception 'Este paciente já está na fila ou em atendimento.' using errcode = '23505';
  end;

  perform public.fila_avisar_n8n(v_atendimento);
  return jsonb_build_object('atendimento_id', v_atendimento, 'paciente_id', v_paciente, 'link_agendado', v_ativo);
end $$;

create or replace function public.fila_reenviar_link(p_atendimento uuid) returns void
language plpgsql security definer set search_path to '' as $$
begin
  perform public.fila_exige_staff();
  if not exists (select 1 from public.atendimentos where id = p_atendimento and status in ('aguardando', 'assinatura_pendente')) then
    raise exception 'Este atendimento não está na fila.' using errcode = 'P0001';
  end if;
  if coalesce((select valor from public.config where chave = 'fila_webhook_url'), '') = '' then
    raise exception 'O envio do link por e-mail ainda não está configurado (config.fila_webhook_url).' using errcode = 'P0001';
  end if;
  perform public.fila_avisar_n8n(p_atendimento);
end $$;

-- Envia o documento para assinatura. O hash é calculado aqui, sobre o texto gravado.
create or replace function public.fila_chamar_assinatura(p_atendimento uuid, p_texto text) returns void
language plpgsql security definer set search_path to '' as $$
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
create or replace function public.fila_cancelar_assinatura(p_atendimento uuid) returns void
language plpgsql security definer set search_path to '' as $$
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

create or replace function public.fila_concluir(p_atendimento uuid) returns void
language plpgsql security definer set search_path to '' as $$
begin
  perform public.fila_exige_staff();
  update public.atendimentos set status = 'concluido' where id = p_atendimento and status = 'em_atendimento';
  if not found then
    raise exception 'Atendimento não está em atendimento.' using errcode = 'P0001';
  end if;
end $$;

create or replace function public.fila_listar() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  perform public.fila_exige_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'nome', p.nome, 'email', a.email_informado, 'status', a.status,
             'created_at', a.created_at, 'tentativas_falhas', a.tentativas_falhas,
             'bloqueado', a.bloqueado_em is not null, 'links_enviados', a.links_enviados)
           order by (a.status = 'concluido'), a.created_at, a.id)
      from public.atendimentos a join public.pacientes p on p.id = a.paciente_id
     where a.status <> 'concluido' or a.atualizado_em > now() - interval '12 hours'), '[]'::jsonb);
end $$;

revoke all on function public.fila_entrar(text, text, text), public.fila_reenviar_link(uuid),
  public.fila_chamar_assinatura(uuid, text), public.fila_cancelar_assinatura(uuid),
  public.fila_concluir(uuid), public.fila_listar() from public, anon;
grant execute on function public.fila_entrar(text, text, text), public.fila_reenviar_link(uuid),
  public.fila_chamar_assinatura(uuid, text), public.fila_cancelar_assinatura(uuid),
  public.fila_concluir(uuid), public.fila_listar() to authenticated;

-- ============================================================
-- 7) Paciente (anon + token do link): estado da fila só em números
-- ============================================================
create or replace function public.fila_estado(p_token text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_claims jsonb := public.fila_jwt_validar(p_token);
  a public.atendimentos%rowtype;
  v_a_frente integer := null;
  v_aguardando integer;
begin
  if v_claims is null then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  select * into a from public.atendimentos where id = (v_claims ->> 'atendimento_id')::uuid;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  select count(*) into v_aguardando from public.atendimentos where status = 'aguardando';
  if a.status = 'aguardando' then
    select count(*) into v_a_frente from public.atendimentos x
     where x.status = 'aguardando' and (x.created_at, x.id) < (a.created_at, a.id);
  end if;
  return jsonb_build_object(
    'ok', true,
    'status', a.status,
    'a_frente', v_a_frente,
    'aguardando', v_aguardando,
    'bloqueado', a.bloqueado_em is not null,
    'tentativas_restantes', greatest(3 - a.tentativas_falhas, 0),
    'documento', case when a.status = 'assinatura_pendente' and a.bloqueado_em is null then a.documento_texto end,
    'expira_em', to_timestamp((v_claims ->> 'exp')::bigint));
end $$;

revoke all on function public.fila_estado(text) from public;
grant execute on function public.fila_estado(text) to anon, authenticated;

-- ============================================================
-- 8) n8n (anon + cabeçalho x-fila-segredo): emitir token, contexto e registro da assinatura
-- ============================================================
create or replace function public.fila_emitir_token(p_atendimento uuid) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  a public.atendimentos%rowtype;
  v_nome text;
  v_agora bigint := floor(extract(epoch from now()))::bigint;
  v_exp bigint := floor(extract(epoch from now()))::bigint + 4 * 3600;
begin
  if not public.fila_n8n_autorizado() then
    raise exception 'Não autorizado.' using errcode = '42501';
  end if;
  select * into a from public.atendimentos where id = p_atendimento for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'atendimento_inexistente');
  end if;
  if a.status not in ('aguardando', 'assinatura_pendente') then
    return jsonb_build_object('ok', false, 'erro', 'fora_da_fila');
  end if;
  if a.links_enviados >= 10 then
    return jsonb_build_object('ok', false, 'erro', 'limite_de_envios');
  end if;
  select nome into v_nome from public.pacientes where id = a.paciente_id;
  update public.atendimentos set links_enviados = links_enviados + 1 where id = a.id;
  return jsonb_build_object(
    'ok', true,
    'token', public.fila_jwt_assinar(jsonb_build_object(
      'aud', 'fila', 'atendimento_id', a.id, 'email_informado', a.email_informado,
      'iat', v_agora, 'exp', v_exp, 'jti', gen_random_uuid())),
    'nome', v_nome,
    'email', a.email_informado,
    'expira_em', to_timestamp(v_exp));
end $$;

-- Leitura (sem trava) para o Python decidir. O estado é conferido de novo, com trava, em assinatura_registrar.
create or replace function public.assinatura_contexto(p_token text, p_hash text) returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare
  v_claims jsonb;
  a public.atendimentos%rowtype;
  v_perfil jsonb;
begin
  if not public.fila_n8n_autorizado() then
    raise exception 'Não autorizado.' using errcode = '42501';
  end if;
  v_claims := public.fila_jwt_validar(p_token);
  if v_claims is null then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  select * into a from public.atendimentos where id = (v_claims ->> 'atendimento_id')::uuid;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  if a.bloqueado_em is not null then
    return jsonb_build_object('ok', false, 'erro', 'bloqueado');
  end if;
  if a.status <> 'assinatura_pendente' then
    return jsonb_build_object('ok', false, 'erro', 'fora_de_assinatura');
  end if;
  if a.documento_hash is distinct from p_hash then
    return jsonb_build_object('ok', false, 'erro', 'documento_diferente');
  end if;
  select perfil_biometrico_historico into v_perfil from public.pacientes where id = a.paciente_id;
  return jsonb_build_object('ok', true, 'perfil', coalesce(v_perfil, '{}'::jsonb), 'tentativas_falhas', a.tentativas_falhas);
end $$;

-- Grava o resultado calculado pelo Python. O banco é a autoridade: refaz as checagens com trava de linha,
-- confere o limiar 0,30 e conta as 3 tentativas por conta própria.
create or replace function public.assinatura_registrar(
  p_token text, p_hash text, p_resultado jsonb, p_pontos jsonb, p_ip text, p_user_agent text
) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_claims jsonb;
  a public.atendimentos%rowtype;
  v_perfil jsonb;
  v_n_base integer;
  v_n_atual integer;
  v_aprovado boolean;
  v_tipo text;
  v_score numeric;
  v_falhas integer;
  v_bloqueado boolean;
begin
  if not public.fila_n8n_autorizado() then
    raise exception 'Não autorizado.' using errcode = '42501';
  end if;
  v_claims := public.fila_jwt_validar(p_token);
  if v_claims is null then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  select * into a from public.atendimentos where id = (v_claims ->> 'atendimento_id')::uuid for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'token_invalido');
  end if;
  if a.bloqueado_em is not null then
    return jsonb_build_object('ok', false, 'erro', 'bloqueado');
  end if;
  if a.status <> 'assinatura_pendente' then
    return jsonb_build_object('ok', false, 'erro', 'fora_de_assinatura');
  end if;
  if a.documento_hash is distinct from p_hash then
    return jsonb_build_object('ok', false, 'erro', 'documento_diferente');
  end if;

  -- CASE em vez de OR: o SQL não garante curto-circuito, e jsonb_array_length lança erro em quem não é array.
  if not coalesce(case when jsonb_typeof(p_pontos) = 'array' then jsonb_array_length(p_pontos) between 20 and 5000 end, false)
     or jsonb_typeof(p_resultado) is distinct from 'object'
     or coalesce(p_resultado ->> 'consentimento', 'false') <> 'true' then
    return jsonb_build_object('ok', false, 'erro', 'resultado_invalido');
  end if;

  select perfil_biometrico_historico into v_perfil from public.pacientes where id = a.paciente_id for update;
  v_n_atual := coalesce((v_perfil ->> 'n')::integer, 0);
  v_n_base := (p_resultado ->> 'perfil_n_base')::integer;
  if v_n_base is distinct from v_n_atual then
    return jsonb_build_object('ok', false, 'erro', 'conflito');   -- outro envio mudou o perfil: tentar de novo, sem contar
  end if;

  v_aprovado := (p_resultado ->> 'aprovado')::boolean;
  v_tipo := p_resultado ->> 'tipo';
  v_score := (p_resultado ->> 'score')::numeric;

  if v_tipo = 'enrolamento' then
    if v_n_atual <> 0 or v_aprovado is not true or v_score is not null then
      return jsonb_build_object('ok', false, 'erro', 'resultado_invalido');
    end if;
  elsif v_tipo = 'comparacao' then
    if v_n_atual = 0 or v_score is null or v_score < 0 or v_score > 1
       or v_aprovado is distinct from (v_score >= 0.30) then
      return jsonb_build_object('ok', false, 'erro', 'resultado_invalido');
    end if;
  else
    return jsonb_build_object('ok', false, 'erro', 'resultado_invalido');
  end if;

  if v_aprovado then
    if jsonb_typeof(p_resultado -> 'perfil_novo') is distinct from 'object'
       or coalesce((p_resultado -> 'perfil_novo' ->> 'n')::integer, 0) <> v_n_atual + 1 then
      return jsonb_build_object('ok', false, 'erro', 'resultado_invalido');
    end if;
    update public.pacientes set perfil_biometrico_historico = p_resultado -> 'perfil_novo', atualizado_em = now()
     where id = a.paciente_id;
    insert into public.registro_assinaturas
      (atendimento_id, email_confirmado_transacao, hash_documento, consentimento_biometrico, tipo_validacao,
       score_similaridade, vetor_traco_bruto, caracteristicas, ip_origem, user_agent)
    values (a.id, v_claims ->> 'email_informado', p_hash, true, v_tipo, v_score, p_pontos,
            coalesce(p_resultado -> 'caracteristicas', '{}'::jsonb), left(p_ip, 45), left(coalesce(p_user_agent, ''), 500));
    update public.atendimentos set status = 'em_atendimento' where id = a.id;
    return jsonb_build_object('ok', true, 'aprovado', true);
  end if;

  v_falhas := a.tentativas_falhas + 1;
  v_bloqueado := v_falhas >= 3;
  update public.atendimentos
     set tentativas_falhas = v_falhas, bloqueado_em = case when v_bloqueado then now() end
   where id = a.id;
  insert into public.assinatura_tentativas (atendimento_id, numero, score_similaridade, ip_origem, user_agent)
  values (a.id, v_falhas, v_score, left(p_ip, 45), left(coalesce(p_user_agent, ''), 500));
  return jsonb_build_object('ok', true, 'aprovado', false,
                            'tentativas_restantes', greatest(3 - v_falhas, 0), 'bloqueado', v_bloqueado);
end $$;

revoke all on function public.fila_emitir_token(uuid), public.assinatura_contexto(text, text),
  public.assinatura_registrar(text, text, jsonb, jsonb, text, text) from public;
grant execute on function public.fila_emitir_token(uuid), public.assinatura_contexto(text, text),
  public.assinatura_registrar(text, text, jsonb, jsonb, text, text) to anon, authenticated;

-- ============================================================
-- 9) Realtime: broadcast privado sem dado pessoal; tabela na publicação para a lista da recepção
-- ============================================================
do $$ begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'atendimentos') then
    alter publication supabase_realtime add table public.atendimentos;
  end if;
end $$;

-- fila:global avisa que a fila andou; atendimento:<id> leva só o status daquele atendimento.
create or replace function public.fila_avisar_trg() returns trigger
language plpgsql security definer set search_path to '' as $$
begin
  perform realtime.send(jsonb_build_object('evento', 'fila_mudou'), 'fila_mudou', 'fila:global', true);
  if tg_op = 'UPDATE' then
    perform realtime.send(jsonb_build_object('status', new.status, 'bloqueado', new.bloqueado_em is not null),
                          'status', 'atendimento:' || new.id::text, true);
  end if;
  return null;
exception when others then
  raise warning 'fila_avisar_trg: %', sqlerrm;   -- falha no aviso nunca bloqueia a gravação do atendimento
  return null;
end $$;

create or replace trigger atendimentos_fila_avisar after insert or update of status, bloqueado_em or delete on public.atendimentos
  for each row execute function public.fila_avisar_trg();
revoke all on function public.fila_avisar_trg() from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'fila_recebe') then
    create policy fila_recebe on realtime.messages for select to anon, authenticated
      using (
        extension = 'broadcast'
        and ((select realtime.topic()) = 'fila:global' or (select realtime.topic()) like 'atendimento:%')
      );
  end if;
end $$;
