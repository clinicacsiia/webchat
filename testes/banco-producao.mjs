// FLUXOGRAMA: entrada (o retrato da estrutura de produção em supabase/producao/: estrutura.sql + funcoes/*.sql) -> validação (cada comando é tentado; o que depende de outro ainda não criado volta para a fila até não sobrar nada ou não haver mais avanço) -> lógica (Postgres embutido PGlite com o Supabase simulado: auth, vault, pg_net, realtime, cron, pgcrypto, unaccent) -> saída (um banco vazio com as MESMAS tabelas, funções, gatilhos, visões e regras de acesso da produção, para os testes)
// Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial
// Por que existe: 96 funções da produção são diferentes de qualquer versão dos arquivos supabase/*.sql e 52 só existem lá.
// Testar contra os arquivos antigos não prova nada sobre o banco real; testar contra o retrato prova.
// Nenhuma linha de tabela vem da produção: cada teste cria os próprios dados inventados.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const REPO = resolve(import.meta.dirname, '..');
const PASTA = `${REPO}/supabase/producao`;

// Separa um texto SQL em comandos, respeitando aspas, $marcas$ e comentários.
export function separarSql(texto) {
  const out = []; let i = 0, ini = 0; const n = texto.length;
  while (i < n) {
    const c = texto[i];
    if (c === '-' && texto[i + 1] === '-') { const f = texto.indexOf('\n', i); i = f < 0 ? n : f + 1; continue; }
    if (c === "'") { i++; while (i < n) { if (texto[i] === "'") { if (texto[i + 1] === "'") { i += 2; continue; } break; } i++; } i++; continue; }
    if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(texto.slice(i, i + 40));
      if (m) { const f = texto.indexOf(m[0], i + m[0].length); i = f < 0 ? n : f + m[0].length; continue; }
    }
    if (c === ';') { const s = texto.slice(ini, i).trim(); if (s.replace(/--[^\n]*/g, '').trim()) out.push(s); ini = i + 1; }
    i++;
  }
  const resto = texto.slice(ini).trim();
  if (resto.replace(/--[^\n]*/g, '').trim()) out.push(resto);
  return out;
}

const STUBS = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  end $$;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), instance_id uuid, aud text, role text, email text unique, encrypted_password text,
    email_confirmed_at timestamptz, confirmation_token text default '', recovery_token text default '', email_change_token_new text default '', email_change text default '',
    raw_app_meta_data jsonb default '{}', raw_user_meta_data jsonb default '{}', last_sign_in_at timestamptz, banned_until timestamptz,
    created_at timestamptz default now(), updated_at timestamptz default now(), is_sso_user boolean default false, is_anonymous boolean default false, deleted_at timestamptz);
  create table auth.identities (id uuid primary key default gen_random_uuid(), provider_id text, user_id uuid references auth.users (id) on delete cascade, identity_data jsonb, provider text,
    last_sign_in_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now());
  create table auth.sessions (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users (id) on delete cascade, created_at timestamptz default now());
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select coalesce(auth.jwt() ->> 'role', current_user::text) $$;

  create schema extensions;
  create function extensions.unaccent(t text) returns text language sql immutable as $$
    select translate(t, 'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', 'aaaaaeeeeiiiiooooouuuucnAAAAAEEEEIIIIOOOOOUUUUCN') $$;
  create function extensions.unaccent(d regdictionary, t text) returns text language sql immutable as $$ select extensions.unaccent(t) $$;
  create function extensions.gen_salt(t text) returns text language sql as $$ select '$stub$' || md5(random()::text) $$;
  create function extensions.gen_salt(t text, n integer) returns text language sql as $$ select '$stub$' || md5(random()::text) $$;
  create function extensions.crypt(senha text, sal text) returns text language sql immutable as $$ select '$stub$' || split_part(sal, '$', 3) || '$' || md5(senha || split_part(sal, '$', 3)) $$;
  create function extensions.hmac(data bytea, key bytea, algo text) returns bytea language plpgsql immutable as $$
  declare k bytea := key; ipad bytea; opad bytea; i int;
  begin
    if length(k) > 64 then k := sha256(k); end if;
    k := k || decode(repeat('00', 64 - length(k)), 'hex'); ipad := k; opad := k;
    for i in 0..63 loop ipad := set_byte(ipad, i, get_byte(k, i) # 54); opad := set_byte(opad, i, get_byte(k, i) # 92); end loop;
    return sha256(opad || sha256(ipad || data));
  end $$;
  create function extensions.hmac(data text, key text, algo text) returns bytea language sql immutable as $$ select extensions.hmac(convert_to(data, 'UTF8'), convert_to(key, 'UTF8'), algo) $$;
  create function extensions.digest(data text, algo text) returns bytea language sql immutable as $$ select sha256(convert_to(data, 'UTF8')) $$;
  create function extensions.digest(data bytea, algo text) returns bytea language sql immutable as $$ select sha256(data) $$;
  create function extensions.uuid_generate_v4() returns uuid language sql as $$ select gen_random_uuid() $$;

  create schema vault;
  create table vault.secrets_tbl (id uuid primary key default gen_random_uuid(), name text unique, secret text not null);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets_tbl;

  create schema net;
  create table net.chamadas (id bigint generated always as identity primary key, url text, body jsonb, headers jsonb, em timestamptz default now());
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
    returns bigint language plpgsql as $$ declare v bigint; begin insert into net.chamadas (url, body, headers) values (url, body, headers) returning id into v; return v; end $$;

  create schema realtime;
  create table realtime.messages (id bigint generated always as identity primary key, topic text not null, extension text not null, event text, payload jsonb, private boolean default false, inserted_at timestamptz default now());
  create function realtime.topic() returns text language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;
  create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void language plpgsql as $$
  begin insert into realtime.messages (topic, extension, event, payload, private) values (topic, 'broadcast', event, payload, private); end $$;

  create schema cron;
  create table cron.job (jobid bigint generated always as identity primary key, jobname text unique, schedule text, command text, active boolean default true);
  create table cron.job_run_details (runid bigint generated always as identity primary key, jobid bigint, status text, return_message text, start_time timestamptz default now(), end_time timestamptz);
  create function cron.schedule(nome text, quando text, comando text) returns bigint language plpgsql as $$ declare v bigint;
  begin insert into cron.job (jobname, schedule, command) values (nome, quando, comando)
        on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid into v; return v; end $$;
  create function cron.unschedule(nome text) returns boolean language plpgsql as $$ begin delete from cron.job where jobname = nome; return found; end $$;

  grant usage on schema auth, realtime, public, extensions to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema extensions to anon, authenticated, service_role;
  create publication supabase_realtime;
`;

// As chaves liga/desliga de public.config como estavam na produção em 11/11/2026 (só as que NÃO são segredo, endereço nem texto longo).
// Os testes rodam com o sistema configurado como o de verdade. Segredos e endereços recebem valores de mentira.
export const CONFIG_PRODUCAO = {
  agenda_ao_vivo: 'sim', agenda_ao_vivo_max_dias: '14', agenda_ao_vivo_trava_s: '40', agenda_ao_vivo_validade_s: '15', agendado_conferir_prazo_min: '120',
  agendamento_reconhecer: 'sim', agendamento_reconhecer_msg_encerradas: 'nao', autoencerrar_horas: '24', autoencerrar_modo: 'ligado', avaliacao_ativa: 'sim',
  cadastro_equipe_sem_convite: 'nao', checkin_sem_login_max_dia: '300', despedida_configurada: 'sim', despedida_inatividade_ativa: 'sim', despedida_versao_atual: '3',
  encerramento_exige_motivo: 'sim', encerramento_valida_agendado: 'sim', fila_autochegada: 'sim', fila_aviso_antes: '2', ia_ativa: 'sim', indicadores_fechar: 'sim',
  jornada_identidade_klingo: 'sim', jornada_relatorio_filtro: 'exame', jornada_relatorio_id: '14359', login_paciente: 'sim', motor: 'fluxo', motor_telefones_teste: '',
  nome_empresa: 'Atendimento', permissao_modo: 'observacao', reabrir_dias: '2', reaproveitar_cadastro_convidado: 'nao', vinculo_manual_quem: 'equipe',
  // de mentira (na produção são segredo, endereço ou texto):
  ia_segredo: 'segredo-de-teste', boas_vindas: 'Olá! Este é o chat de teste.', despedida_inatividade_texto: 'Encerramos por falta de resposta. Quando quiser, é só voltar.',
  convenio_suspenso_texto: 'O convênio {convenio} está temporariamente suspenso.', previsao_texto: 'Os horários são uma previsão; a equipe confirma.',
  horario_trabalho: '', chat_push_url: '', equipe_push_url: '', fila_push_url: '', klingo_paciente_url: '', teste_agentes: '', teste_marcadores: '', fila_vapid_publica: '',
};

// Monta o banco. Devolve { db, falhas } (falhas = comandos do retrato que o PGlite não aceitou, com o motivo).
export async function criarBancoProducao({ silencioso = true, config = true } = {}) {
  const db = new PGlite();
  await db.exec(STUBS);
  await db.exec(`set check_function_bodies = off; set search_path = public, extensions;`);

  const estrutura = readFileSync(`${PASTA}/estrutura.sql`, 'utf8');
  const fila = separarSql(estrutura).map((sql) => ({ sql, de: 'estrutura.sql' }));
  for (const arq of readdirSync(`${PASTA}/funcoes`).sort()) {
    for (const sql of separarSql(readFileSync(`${PASTA}/funcoes/${arq}`, 'utf8'))) fila.push({ sql, de: `funcoes/${arq}` });
  }
  // Visão materializada do retrato nasce vazia e sem índice único: o teste não precisa dos dados dela.
  let pendentes = fila, rodada = 0;
  while (pendentes.length) {
    rodada++;
    const proximos = [];
    for (const c of pendentes) {
      try { await db.exec(c.sql); } catch (e) { c.erro = String(e.message || e).slice(0, 200); proximos.push(c); }
    }
    if (!silencioso) console.log(`  rodada ${rodada}: ${pendentes.length - proximos.length} criados, ${proximos.length} pendentes`);
    if (proximos.length === pendentes.length) break;   // nenhum avanço: o que sobrou é falha de verdade
    pendentes = proximos;
  }
  const falhas = pendentes.length && rodada > 0 && pendentes.every((c) => c.erro) ? pendentes : [];

  // Privilégios de execução iguais aos da produção (anon / authenticated), a partir do índice do retrato.
  const indice = JSON.parse(readFileSync(`${PASTA}/indice.json`, 'utf8'));
  const procs = (await db.query(`select p.oid::regprocedure::text as assinatura, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).rows;
  let grants = '';
  for (const p of procs) {
    const f = indice.funcoes.find((x) => x.nome === p.proname);
    if (!f) continue;
    grants += `revoke all on function ${p.assinatura} from public, anon, authenticated;\n`;
    if (f.publico) grants += `grant execute on function ${p.assinatura} to public;\n`;
    if (f.anon) grants += `grant execute on function ${p.assinatura} to anon;\n`;
    if (f.authenticated) grants += `grant execute on function ${p.assinatura} to authenticated;\n`;
  }
  await db.exec(grants);
  await db.exec(`grant select, insert, update, delete on all tables in schema public to authenticated; grant usage on all sequences in schema public to authenticated, anon;`);
  await db.exec(`set check_function_bodies = on; reset search_path;`);
  if (config) {
    for (const [chave, valor] of Object.entries(CONFIG_PRODUCAO)) await db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);
  }
  return { db, falhas, indice };
}

// Atalhos usados pelos testes.
export const ajudantes = (db) => {
  const q = async (sql, p) => (await db.query(sql, p)).rows;
  const um = async (sql, p) => (await q(sql, p))[0];
  // Passa a agir como um usuário logado (uuid) ou como o sistema ('' = dono do banco, sem login).
  const como = async (uid, papel = 'authenticated') => {
    await db.exec(`reset role;`);
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role: papel }) : '']);
    if (uid) await db.exec(`set role ${papel};`);
  };
  const anonimo = async () => { await db.exec(`reset role;`); await db.query(`select set_config('request.jwt.claims', '', false)`); await db.exec(`set role anon;`); };
  return { q, um, como, anonimo };
};

// Rodando direto (node banco-producao.mjs): monta o banco e diz o que não entrou.
if (import.meta.url === `file://${process.argv[1]}`) {
  const t0 = Date.now();
  const { db, falhas } = await criarBancoProducao({ silencioso: false });
  const n = (await db.query(`select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public')::int as funcoes,
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r')::int as tabelas,
    (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('v','m'))::int as visoes,
    (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal)::int as gatilhos,
    (select count(*) from pg_policies where schemaname = 'public')::int as politicas`)).rows[0];
  console.log(`Banco montado em ${Date.now() - t0} ms:`, JSON.stringify(n));
  for (const f of falhas) console.log(`FALHOU (${f.de}): ${f.erro}\n   ${f.sql.replace(/\s+/g, ' ').slice(0, 160)}`);
  console.log(falhas.length ? `${falhas.length} comando(s) não entraram.` : 'Tudo entrou.');
  process.exit(falhas.length ? 1 : 0);
}
