// FLUXOGRAMA: entrada (segredos de teste) -> validação (cria roles, schemas auth/extensions/vault/net/realtime e as tabelas e funções reais que o módulo exige) -> lógica (hmac por sha256, vault e pg_net simulados; helpers copiados do repositório por nome) -> saída (banco PGlite pronto para receber supabase/fila-biometria.sql)
// Versão 1.0 — 30/10/2026 / Mudança: Implementação inicial
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '..');

// Pega a definição REAL da função no arquivo do projeto (por nome, não por número de linha).
export const funcao = (arquivo, nome) => {
  const texto = readFileSync(`${REPO}/supabase/${arquivo}`, 'utf8');
  const m = texto.match(new RegExp(`create or replace function public\\.${nome}\\([\\s\\S]*?\\$\\$;`));
  if (!m) throw new Error(`função ${nome} não encontrada em ${arquivo}`);
  return m[0];
};

export async function criarBanco({ segJwt, segN8n }) {
  const db = new PGlite();
  // ---------- stubs do Supabase ----------
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;

    create schema extensions;
    create function extensions.hmac(data bytea, key bytea, algo text) returns bytea language plpgsql immutable as $$
    declare k bytea := key; ipad bytea; opad bytea; i int;
    begin
      if algo <> 'sha256' then raise exception 'stub só implementa sha256'; end if;
      if length(k) > 64 then k := sha256(k); end if;
      k := k || decode(repeat('00', 64 - length(k)), 'hex');
      ipad := k; opad := k;
      for i in 0..63 loop
        ipad := set_byte(ipad, i, get_byte(k, i) # 54);
        opad := set_byte(opad, i, get_byte(k, i) # 92);
      end loop;
      return sha256(opad || sha256(ipad || data));
    end $$;
    create function extensions.unaccent(t text) returns text language sql immutable as $$
      select translate(t, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC') $$;

    create schema vault;
    create table vault.secrets_tbl (id uuid primary key default gen_random_uuid(), name text unique, secret text not null);
    create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets_tbl;

    create schema net;
    create table net.chamadas (url text, body jsonb, headers jsonb);
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
      returns bigint language plpgsql as $$ begin insert into net.chamadas values (url, body, headers); return 1; end $$;

    create schema realtime;
    create table realtime.messages (id bigint generated always as identity primary key, topic text not null, extension text not null, event text, payload jsonb, private boolean default false);
    alter table realtime.messages enable row level security;
    create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
    create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void language plpgsql as $$
    begin insert into realtime.messages (topic, extension, event, payload, private) values (topic, 'broadcast', event, payload, private); end $$;

    grant usage on schema auth, realtime, public to anon, authenticated;
    grant execute on function auth.jwt(), auth.uid(), realtime.topic() to anon, authenticated;
    grant select on realtime.messages to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;

    create table public.config (chave text primary key, valor text not null default '');
    create table public.agentes (id uuid primary key, papel text, ativo boolean default true);
    ${funcao('00-base-snapshot.sql', 'papel_atual')}
    create table public.conversas (id uuid primary key default gen_random_uuid());
    create table public.pacientes (
      id uuid primary key default gen_random_uuid(), nome text not null, nome_norm text not null,
      telefones text[] not null default '{}', email text, dt_nasc date, cpf text,
      dados jsonb not null default '{}'::jsonb, validado boolean not null default false, validado_em timestamptz,
      revisar boolean not null default false, origem_conversa uuid references public.conversas(id) on delete set null,
      criado_em timestamptz not null default now(), atualizado_em timestamptz not null default now(), ultima_visita_em timestamptz not null default now());
    alter table public.pacientes enable row level security;
    create policy pacientes_select on public.pacientes for select using ((select public.papel_atual()) = any (array['admin','atendente']));
    ${['norm_nome', 'fone_chave', 'data_ou_nula', 'nome_confere'].map((n) => funcao('pacientes.sql', n)).join('\n')}
    create publication supabase_realtime;
  `);

  await db.query(`insert into vault.secrets_tbl (name, secret) values ('fila_jwt_secret', $1), ('fila_segredo', $2)`, [segJwt, segN8n]);
  return db;
}
