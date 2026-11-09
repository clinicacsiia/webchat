// FLUXOGRAMA: entrada (supabase/encerramento-motivo.sql + despedida.sql + autoencerrar.sql e as funções reais papel_atual e pessoa_membros, num Postgres embutido) -> validação (modo desligado/simulação/ligado; relógio do servidor com o prazo recuado em minutos) -> lógica (marco só com mensagem de PESSOA; 23h59 x 24h; exame em aberto, pessoa unida, conversa antiga e reabertura; fechamento único com motivo Não respondido e uma despedida) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-08)
import { readFileSync } from 'node:fs';
import { criarBanco, funcao, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
await db.exec(`
  create role service_role nologin;
  alter table public.agentes add column nome text;
  alter table public.conversas add column status text not null default 'aguardando', add column agente_id uuid, add column ia_ativa boolean default true,
    add column triagem_resumo text, add column triagem_urgencia text, add column cliente_aguarda_desde timestamptz, add column encerrada_em timestamptz,
    add column alerta_agenda text, add column atualizado_em timestamptz default now();
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid, autor text, agente_id uuid, texto text not null check (char_length(texto) between 1 and 4000), opcoes jsonb);
  create table public.conversa_grupo (conversa_id uuid primary key, grupo_id uuid);
  create table public.v_agendamento_aberto (conversa_id uuid);
  create table public.v_remarcacao_pendente (conversa_id uuid);
  ${funcao('pessoa-unica.sql', 'pessoa_membros')}
  create function public.chat_valida(p uuid, t text) returns void language sql as $$ select 1 $$;
`);
const arq = (n) => readFileSync(`${REPO}/supabase/${n}`, 'utf8');
await caso('os arquivos aplicam sem erro e podem ser aplicados de novo', async () => { for (const n of ['encerramento-motivo.sql', 'despedida.sql', 'autoencerrar.sql']) await db.exec(arq(n)); for (const n of ['encerramento-motivo.sql', 'despedida.sql', 'autoencerrar.sql']) await db.exec(arq(n)); return { ok: true }; });
await db.exec(`
  create trigger conversas_antes_update before update on public.conversas for each row execute function public.conversa_antes_update();
  create trigger conversas_apos_update after update on public.conversas for each row execute function public.conversa_status_mudou();
`);

const pessoaEquipe = '44444444-4444-4444-4444-444444444444';
const modo = (v) => db.query(`update public.config set valor = $1 where chave = 'autoencerrar_modo'`, [v]);
const conv = async (status = 'em_atendimento') => (await db.query(`insert into public.conversas (status, ia_ativa) values ($1, false) returning id`, [status])).rows[0].id;
const msg = (c, autor, agente = null) => db.query(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, $2, $3, 'oi')`, [c, autor, agente]);
const marco = async (c) => (await db.query(`select aguarda_paciente_desde d from public.conversas where id = $1`, [c])).rows[0].d;
const recuar = (c, minutos) => db.query(`update public.conversas set aguarda_paciente_desde = now() - make_interval(mins => $2) where id = $1`, [c, minutos]);
const est = async (c) => (await db.query(`select status, motivo_encerramento m, encerramento_origem o from public.conversas where id = $1`, [c])).rows[0];
const rodar = async () => (await db.query(`select public.autoencerrar_vigiar() r`)).rows[0].r;
const elegiveis = async () => (await db.query(`select count(*)::int n from public.autoencerrar_candidatas()`)).rows[0].n;
const limpar = () => db.exec(`delete from public.v_agendamento_aberto; delete from public.v_remarcacao_pendente; delete from public.conversa_grupo;
  update public.conversas set aguarda_paciente_desde = null where status <> 'encerrada'`);
const despedidas = async (c) => (await db.query(`select count(*)::int n from public.mensagens where conversa_id = $1 and (opcoes ->> 'tipo') = 'despedida'`, [c])).rows[0].n;
const H24 = 24 * 60;

await caso('o marco só nasce com mensagem de PESSOA da equipe; assistente, sistema e paciente não iniciam', async () => {
  const c = await conv();
  await msg(c, 'agente'); const a = await marco(c);
  await msg(c, 'sistema'); const s = await marco(c);
  await msg(c, 'agente', pessoaEquipe); const p = await marco(c);
  return { ok: a === null && s === null && p !== null };
});

await caso('mensagem do paciente zera; nova mensagem da equipe reinicia o prazo', async () => {
  const c = await conv(); await msg(c, 'agente', pessoaEquipe); await recuar(c, 600);
  const velho = await marco(c);
  await msg(c, 'cliente'); const zerado = await marco(c);
  await msg(c, 'agente', pessoaEquipe); const novo = await marco(c);
  await recuar(c, 120); await msg(c, 'agente', pessoaEquipe); const reinicio = await marco(c);
  return { ok: velho !== null && zerado === null && novo !== null && reinicio.getTime() > Date.now() - 5000 };
});

await caso('mensagem da equipe em conversa que NÃO está em atendimento não cria marco', async () => {
  const c = await conv('aguardando'); await msg(c, 'agente', pessoaEquipe);
  return { ok: (await marco(c)) === null };
});

await caso('modo desligado: nada acontece, mesmo vencido', async () => {
  await limpar(); await modo('desligado');
  const c = await conv(); await msg(c, 'agente', pessoaEquipe); await recuar(c, H24 + 60);
  const r = await rodar();
  return { ok: r.modo === 'desligado' && (await est(c)).status === 'em_atendimento' };
});

await caso('23h59 segue aberta; 24h e depois de 24h são elegíveis', async () => {
  await limpar();
  const a = await conv(), b = await conv(), d = await conv();
  for (const c of [a, b, d]) await msg(c, 'agente', pessoaEquipe);
  await recuar(a, H24 - 1); await recuar(b, H24); await recuar(d, H24 + 30);
  const ids = (await db.query(`select * from public.autoencerrar_candidatas() x`)).rows.map((r) => r.x);
  return { ok: !ids.includes(a) && ids.includes(b) && ids.includes(d) && ids.length === 2 };
});

await caso('simulação: conta e registra, sem alterar nenhuma conversa', async () => {
  await limpar(); await modo('simulacao');
  const c = await conv(); await msg(c, 'agente', pessoaEquipe); await recuar(c, H24 + 5);
  const r = await rodar();
  const exec = (await db.query(`select modo, elegiveis, fechadas from public.autoencerramento_execucao order by id desc limit 1`)).rows[0];
  return { ok: r.elegiveis === 1 && r.fechadas === 0 && exec.modo === 'simulacao' && exec.fechadas === 0 && (await est(c)).status === 'em_atendimento' };
});

let fechada;
await caso('ligado: fecha com motivo Não respondido, origem inatividade, UMA despedida, e registra a auditoria', async () => {
  await limpar(); await modo('ligado');
  const c = fechada = await conv(); await msg(c, 'agente', pessoaEquipe); await recuar(c, H24 + 5);
  const r = await rodar(); const e = await est(c);
  const aud = (await db.query(`select count(*)::int n from public.autoencerramento_fechada where conversa_id = $1`, [c])).rows[0].n;
  const log = (await db.query(`select motivo, origem from public.conversa_encerramento where conversa_id = $1`, [c])).rows;
  return { ok: r.fechadas === 1 && e.status === 'encerrada' && e.m === 'nao_respondido' && e.o === 'inatividade' && (await despedidas(c)) === 1 && aud === 1 && log.length === 1 && log[0].origem === 'inatividade' };
});

await caso('rodar de novo (ou dois executores em seguida) não fecha nem duplica nada', async () => {
  const r1 = await rodar(), r2 = await rodar();
  return { ok: r1.fechadas === 0 && r2.fechadas === 0 && (await despedidas(fechada)) === 1 };
});

await caso('resposta do paciente antes da rotina impede o fechamento', async () => {
  await limpar(); await modo('ligado');
  const c = await conv(); await msg(c, 'agente', pessoaEquipe); await recuar(c, H24 + 5);
  await msg(c, 'cliente');
  const r = await rodar();
  return { ok: r.fechadas === 0 && (await est(c)).status === 'em_atendimento' };
});

await caso('exame em aberto ou remarcação pendente: nunca fecha sozinha', async () => {
  await limpar(); await modo('ligado');
  const a = await conv(), b = await conv();
  for (const c of [a, b]) { await msg(c, 'agente', pessoaEquipe); await recuar(c, H24 + 5); }
  await db.query(`insert into public.v_agendamento_aberto values ($1)`, [a]); await db.query(`insert into public.v_remarcacao_pendente values ($1)`, [b]);
  const r = await rodar();
  return { ok: r.fechadas === 0 && (await est(a)).status === 'em_atendimento' && (await est(b)).status === 'em_atendimento' };
});

await caso('conversa antiga sem marco (legado) nunca fecha', async () => {
  await limpar(); await modo('ligado');
  const c = await conv();  // última mensagem da equipe de antes da atualização: sem marco
  const r = await rodar();
  return { ok: r.elegiveis === 0 && (await est(c)).status === 'em_atendimento' };
});

await caso('pessoa unida: só fecha quando TODAS as conversas abertas dela estão vencidas', async () => {
  await limpar(); await modo('ligado');
  const a = await conv(), b = await conv(), g = '99999999-9999-9999-9999-999999999999';
  await db.query(`insert into public.conversa_grupo values ($1, $3), ($2, $3)`, [a, b, g]);
  await msg(a, 'agente', pessoaEquipe); await recuar(a, H24 + 5);
  await msg(b, 'agente', pessoaEquipe);                      // recente
  const r1 = await rodar(); const aindaAberta = (await est(a)).status === 'em_atendimento';
  await recuar(b, H24 + 5);
  const r2 = await rodar();
  return { ok: r1.fechadas === 0 && aindaAberta && r2.fechadas === 2 && (await est(a)).status === 'encerrada' && (await est(b)).status === 'encerrada' };
});

await caso('pessoa unida com uma conversa ainda aguardando o atendimento: não fecha', async () => {
  await limpar(); await modo('ligado');
  const a = await conv(), b = await conv('aguardando'), g = '88888888-8888-8888-8888-888888888888';
  await db.query(`insert into public.conversa_grupo values ($1, $3), ($2, $3)`, [a, b, g]);
  await msg(a, 'agente', pessoaEquipe); await recuar(a, H24 + 5);
  const r = await rodar();
  return { ok: r.fechadas === 0 && (await est(a)).status === 'em_atendimento' };
});

await caso('reabrir (encerrar, reabrir e assumir de novo) não deixa um prazo antigo valendo', async () => {
  await limpar(); await modo('ligado');
  const c = await conv(); await msg(c, 'agente', pessoaEquipe); await recuar(c, H24 + 5);
  await db.query(`update public.conversas set status = 'encerrada' where id = $1`, [c]);
  await db.query(`update public.conversas set status = 'aguardando' where id = $1`, [c]);
  await db.query(`update public.conversas set status = 'em_atendimento' where id = $1`, [c]);
  const r = await rodar();
  return { ok: (await marco(c)) === null && r.fechadas === 0 && (await est(c)).status === 'em_atendimento' };
});

await caso('encerramento manual antes da rotina: a rotina não mexe', async () => {
  await limpar(); await modo('ligado');
  const c = await conv(); await msg(c, 'agente', pessoaEquipe); await recuar(c, H24 + 5);
  await db.query(`update public.conversas set status = 'encerrada', motivo_encerramento = 'agendado', encerramento_origem = 'equipe' where id = $1`, [c]);
  const r = await rodar(); const e = await est(c);
  return { ok: r.fechadas === 0 && e.m === 'agendado' && e.o === 'equipe' };
});

await caso('o prazo em horas vem da chave autoencerrar_horas', async () => {
  await limpar(); await db.query(`update public.config set valor = '2' where chave = 'autoencerrar_horas'`);
  const c = await conv(); await msg(c, 'agente', pessoaEquipe); await recuar(c, 125);
  const n = await elegiveis();
  await db.query(`update public.config set valor = '24' where chave = 'autoencerrar_horas'`);
  return { ok: n === 1 && (await elegiveis()) === 0 };
});

await caso('resumo para o administrador: só administrador lê', async () => {
  const adm = '11111111-1111-1111-1111-111111111111', ate = '22222222-2222-2222-2222-222222222222';
  await db.query(`insert into public.agentes (id, nome, papel) values ($1, 'Admin', 'admin'), ($2, 'Atend', 'atendente')`, [adm, ate]);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: adm })]);
  const r = (await db.query(`select public.autoencerrar_resumo() r`)).rows[0].r;
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: ate })]);
  let negado = false; try { await db.query(`select public.autoencerrar_resumo()`); } catch { negado = true; }
  return { ok: r.horas === 24 && Array.isArray(r.ultimas) && r.ultimas.length > 0 && negado, detalhe: JSON.stringify({ modo: r.modo, elegiveis: r.elegiveis_agora }) };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
