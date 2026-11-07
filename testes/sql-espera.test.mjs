// FLUXOGRAMA: entrada (supabase/espera-longa.sql + as funções reais fluxo_dizer/fluxo_t/fluxo_equipe_online de fase7-motor.sql, num Postgres embutido) -> validação (aplica o arquivo duas vezes; horário de trabalho com data fixa) -> lógica (resposta do assistente NÃO zera o cronômetro, resposta de pessoa zera; aos 10 min um push só à equipe e repete a cada 15; aos 20 min um aviso ao paciente, uma vez, com texto de dentro ou de fora do horário; fora do horário não toca a equipe; cartão sem relógio) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 07/11/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { funcao, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const sql = readFileSync(`${REPO}/supabase/espera-longa.sql`, 'utf8').replace(/select cron\.schedule\([\s\S]*?\);\s*$/, '');
const fase7 = readFileSync(`${REPO}/supabase/fase7-motor.sql`, 'utf8');
const seed = fase7.match(/insert into public\.fluxo_texto \(chave, texto, descricao\) values[\s\S]*?on conflict \(chave\) do nothing;/)[0];

const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema net; create table net.chamadas (url text, body jsonb, headers jsonb);
  create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds int default 5000)
    returns bigint language plpgsql as $$ begin insert into net.chamadas values (url, body, headers); return 1; end $$;
  create schema realtime; create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void language sql as $$ select 1 $$;
  create table public.config (chave text primary key, valor text not null default '');
  create table public.agentes (id uuid primary key default gen_random_uuid(), nome text, papel text, ativo boolean default true, visto_em timestamptz);
  create table public.contatos (id uuid primary key default gen_random_uuid(), ultimo_contato_em timestamptz);
  create table public.conversas (id uuid primary key default gen_random_uuid(), contato_id uuid, status text default 'aguardando', ia_ativa boolean default false,
    ultima_mensagem text, atualizado_em timestamptz, nao_lidas_agente int default 0, cliente_aguarda_desde timestamptz, agente_id uuid);
  create table public.conversa_segredo (conversa_id uuid primary key, token text);
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid, autor text, agente_id uuid, texto text, opcoes jsonb, criado_em timestamptz default now());
  create table public.pre_agendamentos (conversa_id uuid, status text, tipo text, conferencia_status text, escolha_horario jsonb);
  create table public.fluxo_texto (chave text primary key, texto text not null, descricao text);
  ${seed}
  create function public.fila_aviso_segredo() returns text language sql as $$ select 'segredo-teste' $$;
  create function public.chat_valida(p uuid, t text) returns void language sql as $$ select 1 $$;
  create function public.fluxo_ctx(p uuid) returns jsonb language sql as $$ select '{"nome":"Ana"}'::jsonb $$;
  ${['fluxo_equipe_online', 'fluxo_dizer', 'fluxo_t'].map((n) => funcao('fase7-motor.sql', n)).join('\n')}
`);
// Estado do banco em produção: textos já trocados pela Fase 9 (a migração parte deles).
await db.exec(readFileSync(`${REPO}/supabase/fase9-sentinela.sql`, 'utf8').match(/-- ===== 2\. Textos[\s\S]*?end \$\$;/)[0]);
// O texto que a equipe pode ter editado antes da migração não pode ser sobrescrito.
await db.exec(`update public.fluxo_texto set texto = 'Texto editado pela equipe' where chave = 'transferir_online'`);
await db.exec(`insert into public.config values ('equipe_push_url', 'https://exemplo.test/avisar')`);

await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.exec(`create trigger t after insert on public.mensagens for each row execute function public.mensagem_inserida()`);

const nova = async (iaAtiva = false) => (await db.query(`insert into public.conversas (status, ia_ativa) values ('aguardando', $1) returning id`, [iaAtiva])).rows[0].id;
const msg = (c, autor, agente = null) => db.query(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, $2, $3, 'oi')`, [c, autor, agente]);
const desde = async (c) => (await db.query(`select cliente_aguarda_desde d from public.conversas where id = $1`, [c])).rows[0].d;
const horario = (todos) => db.query(`update public.config set valor = $1 where chave = 'horario_trabalho'`, [JSON.stringify({ fuso: 'America/Sao_Paulo', dias: todos ? [1, 2, 3, 4, 5, 6, 7] : [], inicio: '00:00', fim: '23:59' })]);
const atrasar = (c, min) => db.query(`update public.conversas set cliente_aguarda_desde = now() - make_interval(mins => $2) where id = $1`, [c, min]);
const chamadas = async () => (await db.query(`select body from net.chamadas order by 1`)).rows;
const limpar = () => db.exec(`delete from net.chamadas`);

const humano = (await db.query(`insert into public.agentes (nome, papel) values ('Bia', 'atendente') returning id`)).rows[0].id;

await caso('mensagem do assistente virtual (sem agente_id) NÃO zera o cronômetro', async () => {
  const c = await nova(); await msg(c, 'cliente'); const antes = await desde(c);
  await msg(c, 'agente');
  return { ok: antes !== null && (await desde(c))?.getTime() === antes.getTime() };
});
await caso('resposta de uma pessoa (com agente_id) zera o cronômetro', async () => {
  const c = await nova(); await msg(c, 'cliente'); await msg(c, 'agente', humano);
  return { ok: (await desde(c)) === null };
});

await caso('horário de trabalho: dentro e fora (data fixa, fuso de Brasília)', async () => {
  const r = async (iso) => (await db.query(`select public.horario_trabalho_agora($1::timestamptz) v`, [iso])).rows[0].v;
  await db.query(`update public.config set valor = '{"fuso":"America/Sao_Paulo","dias":[1,2,3,4,5],"inicio":"08:00","fim":"18:00"}' where chave = 'horario_trabalho'`);
  const seg10 = await r('2026-11-09T13:00:00Z'), seg7 = await r('2026-11-09T10:00:00Z'), seg18 = await r('2026-11-09T21:00:00Z'), sab = await r('2026-11-07T15:00:00Z');
  return { ok: seg10 === true && seg7 === false && seg18 === false && sab === false, detalhe: JSON.stringify({ seg10, seg7, seg18, sab }) };
});

await horario(true);
await caso('9 min de espera: nada acontece', async () => {
  await limpar(); const c = await nova(); await msg(c, 'cliente'); await atrasar(c, 9);
  await db.query(`select public.espera_vigiar()`);
  return { ok: (await chamadas()).length === 0 };
});
await caso('10 min de espera, em horário de trabalho: UM push à equipe com a contagem; no minuto seguinte não repete', async () => {
  await limpar(); await db.exec(`delete from public.conversas`); const a = await nova(); const b = await nova();
  for (const c of [a, b]) { await msg(c, 'cliente'); await atrasar(c, 11); }
  await db.query(`select public.espera_vigiar()`); await db.query(`select public.espera_vigiar()`);
  const ch = await chamadas();
  return { ok: ch.length === 1 && ch[0].body.tipo === 'espera' && ch[0].body.quantidade === 2, detalhe: JSON.stringify(ch) };
});
await caso('o push da espera não leva nome nem texto da conversa', async () => {
  const [{ body }] = await chamadas();
  return { ok: JSON.stringify(Object.keys(body).sort()) === JSON.stringify(['quantidade', 'tipo']) };
});
await caso('espera que continua: o push repete só depois de 15 min', async () => {
  await limpar(); await db.exec(`delete from public.conversas`); const c = await nova(); await msg(c, 'cliente'); await atrasar(c, 60);
  await db.query(`select public.espera_vigiar()`);
  await db.query(`update public.conversas set espera_alerta_em = now() - interval '14 minutes'`); await db.query(`select public.espera_vigiar()`);
  const aos14 = (await chamadas()).length;
  await db.query(`update public.conversas set espera_alerta_em = now() - interval '16 minutes'`); await db.query(`select public.espera_vigiar()`);
  return { ok: aos14 === 1 && (await chamadas()).length === 2, detalhe: `${aos14} -> ${(await chamadas()).length}` };
});
await caso('assistente ainda atendendo (ia_ativa) não gera alerta nem aviso', async () => {
  await limpar(); await db.exec(`delete from public.conversas`); const c = await nova(true); await msg(c, 'cliente'); await atrasar(c, 40);
  await db.query(`select public.espera_vigiar()`);
  return { ok: (await chamadas()).length === 0 && (await db.query(`select 1 from public.mensagens where conversa_id = $1 and autor = 'agente'`, [c])).rows.length === 0 };
});
await caso('conversa encerrada não gera alerta nem aviso', async () => {
  await limpar(); await db.exec(`delete from public.conversas`); const c = await nova(); await msg(c, 'cliente'); await atrasar(c, 40);
  await db.query(`update public.conversas set status = 'encerrada' where id = $1`, [c]); await db.query(`select public.espera_vigiar()`);
  return { ok: (await chamadas()).length === 0 && (await db.query(`select 1 from public.mensagens where conversa_id = $1 and autor = 'agente'`, [c])).rows.length === 0 };
});

const avisos = async (c) => (await db.query(`select texto, agente_id from public.mensagens where conversa_id = $1 and autor = 'agente' order by id`, [c])).rows;
await caso('19 min: sem aviso ao paciente; 20 min: UM aviso, uma vez só, e o aviso não zera o cronômetro', async () => {
  await db.exec(`delete from public.conversas`); const c = await nova(); await msg(c, 'cliente'); await atrasar(c, 19);
  await db.query(`select public.espera_vigiar()`); const aos19 = (await avisos(c)).length;
  await atrasar(c, 21); await db.query(`select public.espera_vigiar()`); await db.query(`select public.espera_vigiar()`);
  const a = await avisos(c);
  return { ok: aos19 === 0 && a.length === 1 && /muitas conversas/.test(a[0].texto) && /já foi sinalizado à equipe/.test(a[0].texto) && !/min|\d{2}:\d{2}/.test(a[0].texto) && (await desde(c)) !== null, detalhe: JSON.stringify(a) };
});
await caso('os textos do chat não prometem mais "online e acompanhando", "em instantes" nem "equipe acompanha"', async () => {
  const t = (await db.query(`select texto from public.fluxo_texto where chave in ('espera_longa_dentro','espera_longa_fora','pronto_online','transferir_online','ola_proprio','ola_filho')`)).rows.map((r) => r.texto);
  const ruim = t.filter((x) => /online e acompanhando|em instantes|equipe acompanha/i.test(x));
  return { ok: ruim.length === 0, detalhe: ruim.join(' | ') };
});
await caso('nova espera depois de uma resposta humana: o aviso pode valer de novo', async () => {
  await db.exec(`delete from public.conversas`); const c = await nova(); await msg(c, 'cliente'); await atrasar(c, 25);
  await db.query(`select public.espera_vigiar()`); await msg(c, 'agente', humano);
  await db.query(`update public.conversas set espera_aviso_paciente_em = now() - interval '60 minutes'`);   // o aviso foi dado há tempo, antes desta nova espera
  await msg(c, 'cliente'); await atrasar(c, 25); await db.query(`select public.espera_vigiar()`);
  return { ok: (await avisos(c)).filter((x) => x.agente_id === null).length === 2 };
});
await horario(false);
await caso('fora do horário de trabalho: aos 20 min o paciente recebe o texto de fora do horário e a equipe NÃO é tocada', async () => {
  await limpar(); await db.exec(`delete from public.conversas`); const c = await nova(); await msg(c, 'cliente'); await atrasar(c, 30);
  await db.query(`select public.espera_vigiar()`);
  const a = await avisos(c);
  return { ok: a.length === 1 && /não estamos em horário de trabalho/.test(a[0].texto) && /entraremos em contato/.test(a[0].texto) && (await chamadas()).length === 0, detalhe: JSON.stringify(a) };
});
await caso('a rotina não cai sem URL de push configurada (só não avisa a equipe)', async () => {
  await horario(true); await db.exec(`update public.config set valor = '' where chave = 'equipe_push_url'`); await limpar(); await db.exec(`delete from public.conversas`);
  const c = await nova(); await msg(c, 'cliente'); await atrasar(c, 30);
  const r = (await db.query(`select public.espera_vigiar() r`)).rows[0].r;
  return { ok: r.erro === null && r.alertadas === 1 && r.avisadas === 1 && (await chamadas()).length === 0, detalhe: JSON.stringify(r) };
});

await caso('cartão do paciente: sem relógio nem "enviado_em", com horário de trabalho e aviso de fila', async () => {
  await db.exec(`delete from public.conversas`); const c = await nova(); await msg(c, 'cliente'); await atrasar(c, 30); await db.query(`select public.espera_vigiar()`);
  const r = (await db.query(`select public.chat_acompanhar($1, 'x') r`, [c])).rows[0].r;
  return { ok: !('enviado_em' in r) && !('agora' in r) && r.em_horario === true && r.espera_longa === true && r.confirmado === false, detalhe: JSON.stringify(r) };
});
await caso('cartão: depois que uma pessoa responde, o aviso de fila some', async () => {
  const c = (await db.query(`select id from public.conversas limit 1`)).rows[0].id; await msg(c, 'agente', humano);
  const r = (await db.query(`select public.chat_acompanhar($1, 'x') r`, [c])).rows[0].r;
  return { ok: r.espera_longa === false };
});
await caso('texto editado pela equipe não é sobrescrito pela migração', async () => {
  return { ok: (await db.query(`select texto from public.fluxo_texto where chave = 'transferir_online'`)).rows[0].texto === 'Texto editado pela equipe' };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
