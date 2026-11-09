// FLUXOGRAMA: entrada (supabase/encerramento-motivo.sql + as funções reais papel_atual, conversa_exame_aberto_trg e pessoa_membros, num Postgres embutido) -> validação (aplica o arquivo duas vezes; usuário do painel x sistema; chave config.encerramento_exige_motivo desligada e ligada) -> lógica (motivo, autor, origem e histórico por fechamento; exame em aberto continua bloqueando; reabrir limpa o motivo) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-03)
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { funcao, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const sql = readFileSync(`${REPO}/supabase/encerramento-motivo.sql`, 'utf8');
const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  create table public.config (chave text primary key, valor text not null default '');
  create table public.agentes (id uuid primary key, nome text, papel text, ativo boolean default true);
  ${funcao('00-base-snapshot.sql', 'papel_atual')}
  create table public.conversas (id uuid primary key default gen_random_uuid(), status text not null default 'aguardando', agente_id uuid,
    ia_ativa boolean default true, triagem_resumo text, triagem_urgencia text, cliente_aguarda_desde timestamptz, encerrada_em timestamptz,
    alerta_agenda text, atualizado_em timestamptz default now());
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid, autor text, texto text);
  create table public.conversa_grupo (conversa_id uuid primary key, grupo_id uuid);
  create table public.v_agendamento_aberto (conversa_id uuid);   -- vira tabela só no teste
  create table public.v_remarcacao_pendente (conversa_id uuid);
  ${funcao('pessoa-unica.sql', 'pessoa_membros')}
  ${funcao('pessoa-unica.sql', 'conversa_exame_aberto_trg')}
  create trigger conversa_exame_aberto before update of status on public.conversas for each row execute function public.conversa_exame_aberto_trg();
`);
const velho = (await db.query(`insert into public.conversas (status, encerrada_em) values ('encerrada', now() - interval '3 days') returning id`)).rows[0].id;

await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.exec(`
  create trigger conversas_antes_update before update on public.conversas for each row execute function public.conversa_antes_update();
  create trigger conversas_apos_update after update on public.conversas for each row execute function public.conversa_status_mudou();
`);

const ana = '11111111-1111-1111-1111-111111111111';
await db.query(`insert into public.agentes (id, nome, papel) values ($1, 'Ana', 'atendente')`, [ana]);
const painel = () => db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: ana })]);
const sistema = () => db.query(`select set_config('request.jwt.claims', '', false)`);
const exige = (v) => db.query(`update public.config set valor = $1 where chave = 'encerramento_exige_motivo'`, [v]);
const nova = async (status = 'em_atendimento') => (await db.query(`insert into public.conversas (status) values ($1) returning id`, [status])).rows[0].id;
const ler = async (id) => (await db.query(`select status, motivo_encerramento m, encerramento_origem o, encerrada_por por from public.conversas where id = $1`, [id])).rows[0];
const log = async (id) => (await db.query(`select motivo, origem from public.conversa_encerramento where conversa_id = $1 order by id`, [id])).rows;
const tenta = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

await caso('a chave nasce desligada e o histórico traz os fechamentos que já existiam', async () => {
  const v = (await db.query(`select valor from public.config where chave = 'encerramento_exige_motivo'`)).rows[0]?.valor;
  const l = await log(velho);
  return { ok: v === 'nao' && l.length === 1 && l[0].motivo === null, detalhe: `chave=${v}, linhas=${l.length}` };
});

await caso('chave desligada: o painel encerra sem motivo (compatível com o painel antigo)', async () => {
  await painel(); await exige('nao');
  const c = await nova(); await db.query(`update public.conversas set status = 'encerrada' where id = $1`, [c]);
  const r = await ler(c);
  return { ok: r.status === 'encerrada' && r.m === null && r.o === 'equipe' && r.por === ana };
});

await caso('chave ligada: sem motivo, a conversa continua aberta e o erro é MOTIVO_OBRIGATORIO', async () => {
  await painel(); await exige('sim');
  const c = await nova();
  const erro = await tenta(() => db.query(`update public.conversas set status = 'encerrada' where id = $1`, [c]));
  const r = await ler(c);
  return { ok: /MOTIVO_OBRIGATORIO/.test(erro || '') && r.status === 'em_atendimento' && (await log(c)).length === 0, detalhe: String(erro).slice(0, 60) };
});

await caso('chave ligada: motivo inválido é recusado e válido fecha com motivo, autor e origem', async () => {
  await painel(); await exige('sim');
  const c = await nova();
  const erro = await tenta(() => db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'qualquer' where id = $1`, [c]));
  const ant = await ler(c);
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'apenas_informacoes' where id = $1`, [c]);
  const r = await ler(c);
  return { ok: !!erro && ant.status === 'em_atendimento' && r.status === 'encerrada' && r.m === 'apenas_informacoes' && r.o === 'equipe' && r.por === ana };
});

await caso('os 5 motivos da decisão D1 são aceitos', async () => {
  await painel(); await exige('sim');
  const ok = [];
  for (const m of ['agendado', 'apenas_informacoes', 'nao_respondido', 'desistiu', 'outro']) {
    const c = await nova(); await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = $2 where id = $1`, [c, m]);
    ok.push((await ler(c)).m === m);
  }
  return { ok: ok.every(Boolean) };
});

await caso('uma mensagem de sistema por fechamento e uma linha no histórico', async () => {
  await painel(); await exige('sim');
  const c = await nova(); await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'desistiu' where id = $1`, [c]);
  const n = (await db.query(`select count(*)::int n from public.mensagens where conversa_id = $1 and autor = 'sistema' and texto like 'Atendimento encerrado%'`, [c])).rows[0].n;
  const l = await log(c);
  return { ok: n === 1 && l.length === 1 && l[0].motivo === 'desistiu' && l[0].origem === 'equipe' };
});

await caso('sistema (sem usuário do painel) não é barrado nem com a chave ligada', async () => {
  await sistema(); await exige('sim');
  const c = await nova(); await db.query(`update public.conversas set status = 'encerrada' where id = $1`, [c]);
  const r = await ler(c);
  return { ok: r.status === 'encerrada' && r.o === 'sistema' && r.por === null };
});

await caso('conversa_encerrar_se_resolvida fecha com motivo Agendado e origem sistema', async () => {
  await sistema(); await exige('sim');
  const c = await nova('aguardando');
  await db.query(`select public.conversa_encerrar_se_resolvida($1)`, [c]);
  const r = await ler(c); const l = await log(c);
  return { ok: r.status === 'encerrada' && r.m === 'agendado' && r.o === 'sistema' && l[0]?.motivo === 'agendado' };
});

await caso('reabrir limpa o motivo e o histórico guarda os dois fechamentos', async () => {
  await painel(); await exige('sim');
  const c = await nova(); await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'outro' where id = $1`, [c]);
  await db.query(`update public.conversas set status = 'aguardando' where id = $1`, [c]);
  const aberta = await ler(c);
  await db.query(`select pg_sleep(0.01)`);
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'agendado' where id = $1`, [c]);
  const l = await log(c);
  return { ok: aberta.m === null && aberta.o === null && aberta.por === null && l.length === 2 && l[0].motivo === 'outro' && l[1].motivo === 'agendado' };
});

await caso('pessoa com várias conversas: o mesmo motivo vale para todas', async () => {
  await painel(); await exige('sim');
  const a = await nova(), b = await nova();
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'desistiu' where id = any ($1)`, [[a, b]]);
  const ra = await ler(a), rb = await ler(b);
  return { ok: ra.m === 'desistiu' && rb.m === 'desistiu' && (await log(a)).length === 1 && (await log(b)).length === 1 };
});

await caso('exame em aberto continua bloqueando o encerramento pelo painel, mesmo com motivo', async () => {
  await painel(); await exige('sim');
  const c = await nova(); await db.query(`insert into public.v_agendamento_aberto values ($1)`, [c]);
  const erro = await tenta(() => db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'outro' where id = $1`, [c]));
  await db.query(`delete from public.v_agendamento_aberto`);
  return { ok: /EXAME_EM_ABERTO/.test(erro || '') && (await ler(c)).status === 'em_atendimento' };
});

await caso('resumo por motivo para a aba Indicadores: conta por motivo e os sem motivo; marketing não lê', async () => {
  await painel();
  const r = (await db.query(`select public.encerramentos_resumo(30) r`)).rows[0].r;
  await db.query(`insert into public.agentes (id, nome, papel) values ('55555555-5555-5555-5555-555555555555', 'Mkt', 'marketing')`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: '55555555-5555-5555-5555-555555555555' })]);
  let negado = false; try { await db.query(`select public.encerramentos_resumo(30)`); } catch { negado = true; }
  return { ok: r.total >= 10 && r.por_motivo.outro >= 1 && r.por_motivo.desistiu >= 1 && r.por_motivo.sem_motivo >= 1 && negado, detalhe: JSON.stringify(r.por_motivo) };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
