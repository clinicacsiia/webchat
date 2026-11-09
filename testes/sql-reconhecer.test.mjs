// FLUXOGRAMA: entrada (supabase/agendamento-reconhecer.sql, a função real nome_confere e tabelas mínimas do chat e da Jornada, num Postgres embutido) -> validação (telefone E nome; marcação feita depois da conversa; só agendado/confirmado; prontuário "conv:" ignorado) -> lógica (mesma data e hora vira agendado sem mensagem ao paciente; outras datas só avisa; não mexe em quem já foi conferido; idempotente; simulação não grava) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 09/11/2026 / Mudança: Implementação inicial (WC-02)
import { readFileSync } from 'node:fs';
import { criarBanco, REPO } from './stubs-supabase.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${e.message.split('\n')[0]}`); } };

const db = await criarBanco({ segJwt: 'x', segN8n: 'y' });
await db.exec(`
  create role service_role nologin;
  alter table public.conversas add column status text default 'em_atendimento', add column criado_em timestamptz default now(), add column contato_id uuid, add column alerta_agenda text, add column atualizado_em timestamptz default now();
  create table public.contatos (id uuid primary key default gen_random_uuid(), nome text, telefone text);
  create table public.mensagens (id bigint generated always as identity primary key, conversa_id uuid, autor text, texto text);
  create table public.pre_agendamentos (id uuid primary key default gen_random_uuid(), conversa_id uuid, status text, criado_em timestamptz default now(), atualizado_em timestamptz default now(), paciente jsonb,
    escolha_horario jsonb, conferencia_status text, conferencia_detalhe text, conferencia_via text, conferencia_em timestamptz, conferencia_falhas int, agendado_auto_em timestamptz, confirmacao_enviada_em timestamptz);
  create table public.jornada_paciente (prontuario text primary key, nome text, fone_chave text);
  create table public.jornada_card (id bigint generated always as identity primary key, paciente_chave text, arquivado_em timestamptz);
  create table public.jornada_exame (id bigint generated always as identity primary key, card_id bigint, procedimento text, status text, agendado_para timestamptz, agendado_em timestamptz);
  insert into public.config values ('ia_segredo', 'segredo-teste');
`);
const sql = readFileSync(`${REPO}/supabase/agendamento-reconhecer.sql`, 'utf8');
await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

const hash = async (tel) => (await db.query(`select encode(sha256(convert_to(right(regexp_replace($1, '\\D', '', 'g'), 8) || 'segredo-teste', 'UTF8')), 'hex') h`, [tel])).rows[0].h;
// Cenário: pedido criado às 12:50 (UTC); escolha no chat em dia/hora de Brasília (UTC-3). Klingo: marcação feita às 12:57.
async function cenario({ nomeChat = 'Flora Juriti de Oliveira Cordeiro', nomeKlingo = 'FLORA JURITI DE OLIVEIRA CORDEIRO', telChat = '7199' + String(Math.floor(1e6 + Math.random() * 9e6)), telKlingo = telChat, prontuario = null,
  status = 'pronto', escolha = [{ data: '2026-12-02', hora: '08:00', min: 15, chegada: false, profissional: 'CAMILA', unidade: 'DESENVOAR' }],
  exames = [{ proc: 'CONSULTA', para: '2026-12-02T11:00:00Z', em: '2026-11-09T12:57:00Z', status: 'agendado' }], convStatus = 'encerrada', conferencia = null } = {}) {
  prontuario = prontuario ?? 'P' + Math.floor(Math.random() * 1e9);
  const ct = (await db.query(`insert into public.contatos (nome, telefone) values ('Mãe', $1) returning id`, [telChat])).rows[0].id;
  const c = (await db.query(`insert into public.conversas (status, contato_id, criado_em) values ($1, $2, '2026-11-09T12:50:00Z') returning id`, [convStatus, ct])).rows[0].id;
  const pre = (await db.query(`insert into public.pre_agendamentos (conversa_id, status, criado_em, paciente, escolha_horario, conferencia_status, conferencia_detalhe) values ($1, $2, now(), $3, $4, $5, $6) returning id`,
    [c, status, JSON.stringify({ nome: nomeChat }), JSON.stringify(escolha), conferencia, conferencia ? 'texto da conferência automática' : null])).rows[0].id;
  await db.query(`insert into public.jornada_paciente values ($1, $2, $3)`, [prontuario, nomeKlingo, await hash(telKlingo)]);
  const k = (await db.query(`insert into public.jornada_card (paciente_chave) values ($1) returning id`, [prontuario])).rows[0].id;
  for (const e of exames) await db.query(`insert into public.jornada_exame (card_id, procedimento, status, agendado_para, agendado_em) values ($1, $2, $3, $4, $5)`, [k, e.proc, e.status, e.para, e.em]);
  return { c, pre };
}
const ler = async (pre) => (await db.query(`select status, conferencia_status cs, conferencia_detalhe det, conferencia_via via, confirmacao_enviada_em is not null enviada from public.pre_agendamentos where id = $1`, [pre])).rows[0];
const msgs = async (c) => (await db.query(`select count(*)::int n from public.mensagens where conversa_id = $1`, [c])).rows[0].n;
const rodar = async (aplicar = true) => (await db.query(`select public.agendamento_reconhecer_klingo($1) r`, [aplicar])).rows[0].r;

await caso('simulação (false) conta e devolve os ids, sem gravar nada', async () => {
  const { pre } = await cenario();
  const r = await rodar(false); const l = await ler(pre);
  return { ok: r.aplicado === false && r.mesma_data_e_hora >= 1 && r.ids_mesma_data_e_hora.includes(pre) && l.status === 'pronto' };
});

await caso('mesma data e horário, mesmo paciente (telefone e nome): vira agendado, sem mensagem ao paciente', async () => {
  const { c, pre } = await cenario();   // Klingo 11:00Z = 08:00 em Brasília; o chat escolheu 08:00
  await rodar(); const l = await ler(pre);
  return { ok: l.status === 'agendado' && l.cs === 'confirmado' && l.via === 'ambos' && l.enviada === true && (await msgs(c)) === 0 };
});

await caso('horário até 30 min de diferença ainda vale; 45 min não (cai em "outras datas")', async () => {
  const a = await cenario({ exames: [{ proc: 'CONSULTA', para: '2026-12-02T11:25:00Z', em: '2026-11-09T12:57:00Z', status: 'agendado' }] });
  const b = await cenario({ exames: [{ proc: 'CONSULTA', para: '2026-12-02T11:45:00Z', em: '2026-11-09T12:57:00Z', status: 'agendado' }] });
  await rodar();
  return { ok: (await ler(a.pre)).status === 'agendado' && (await ler(b.pre)).status === 'pronto' && (await ler(b.pre)).cs === 'divergente' };
});

await caso('horário por ordem de chegada: basta ser o mesmo dia', async () => {
  const { pre } = await cenario({ escolha: [{ data: '2026-12-02', hora: '07:00', chegada: true }], exames: [{ proc: 'RM', para: '2026-12-02T15:40:00Z', em: '2026-11-09T12:57:00Z', status: 'confirmado' }] });
  await rodar();
  return { ok: (await ler(pre)).status === 'agendado' };
});

await caso('só em OUTRAS datas (pedido incompleto): não muda o status; avisa a equipe com as datas, e a conversa encerrada não recebe alerta', async () => {
  const { c, pre } = await cenario({ nomeChat: 'Anthony Kauã Nogueira Machado', nomeKlingo: 'ANTHONY KAUA NOGUEIRA MACHADO', status: 'rascunho', telChat: '71999993856', telKlingo: '71999993856',
    escolha: [{ data: '2026-11-21', hora: '10:55', min: 25, chegada: false }],
    exames: [{ proc: 'CONSULTA', para: '2026-11-14T13:05:00Z', em: '2026-11-09T13:42:00Z', status: 'agendado' }, { proc: 'CONSULTA NEUROPEDIATRIA', para: '2026-11-24T12:20:00Z', em: '2026-11-09T13:50:00Z', status: 'agendado' }] });
  await rodar(); const l = await ler(pre);
  const alerta = (await db.query(`select alerta_agenda a from public.conversas where id = $1`, [c])).rows[0].a;
  return { ok: l.status === 'rascunho' && l.cs === 'divergente' && /14\/11 10:05/.test(l.det) && /24\/11 09:20/.test(l.det) && /outras datas/.test(l.det) && alerta === null, detalhe: l.det };
});

await caso('conversa ainda aberta recebe o alerta; rodar de novo não repete nem muda nada', async () => {
  const { c, pre } = await cenario({ convStatus: 'em_atendimento', escolha: [{ data: '2026-12-09', hora: '08:00', chegada: false }] });
  await rodar(); const a1 = (await db.query(`select alerta_agenda a, atualizado_em t from public.conversas where id = $1`, [c])).rows[0];
  const antes = await ler(pre); const r2 = await rodar(); const depois = await ler(pre);
  const a2 = (await db.query(`select atualizado_em t from public.conversas where id = $1`, [c])).rows[0];
  return { ok: a1.a === 'Já tem marcação no Klingo em outras datas' && JSON.stringify(antes) === JSON.stringify(depois) && a1.t.getTime() === a2.t.getTime() && r2.outras_datas === 0 };
});

await caso('mesmo telefone, nome diferente (família): não reconhece', async () => {
  const { pre } = await cenario({ nomeKlingo: 'CARLOS PEREIRA DIAS', nomeChat: 'Joana Pereira Dias' });
  await rodar(); return { ok: (await ler(pre)).status === 'pronto' && (await ler(pre)).cs === null };
});

await caso('mesmo nome, telefone diferente: não reconhece', async () => {
  const { pre } = await cenario({ telKlingo: '71911112222' });
  await rodar(); return { ok: (await ler(pre)).status === 'pronto' && (await ler(pre)).cs === null };
});

await caso('marcação feita ANTES da conversa, cancelada ou atendida: não conta', async () => {
  const a = await cenario({ exames: [{ proc: 'CONSULTA', para: '2026-12-02T11:00:00Z', em: '2026-11-01T10:00:00Z', status: 'agendado' }] });
  const b = await cenario({ exames: [{ proc: 'CONSULTA', para: '2026-12-02T11:00:00Z', em: '2026-11-09T12:57:00Z', status: 'cancelado' }] });
  const c = await cenario({ exames: [{ proc: 'CONSULTA', para: '2026-12-02T11:00:00Z', em: '2026-11-09T12:57:00Z', status: 'atendido' }] });
  await rodar();
  return { ok: (await ler(a.pre)).status === 'pronto' && (await ler(b.pre)).status === 'pronto' && (await ler(c.pre)).status === 'pronto' };
});

await caso('quem já tem veredito da conferência automática (divergente com texto próprio) não tem o texto trocado; mesma data e hora ainda vira agendado', async () => {
  const x = await cenario({ conferencia: 'divergente', escolha: [{ data: '2026-11-28', hora: '08:00', chegada: false }] });   // outra data: mantém o texto do sistema
  const y = await cenario({ conferencia: 'divergente' });                                                                       // mesma data e hora: agenda
  await rodar();
  return { ok: (await ler(x.pre)).det === 'texto da conferência automática' && (await ler(y.pre)).status === 'agendado' && (await ler(y.pre)).det === null };
});

await caso('pedido já agendado, cancelado ou antigo (mais de 14 dias) não é tocado', async () => {
  const a = await cenario({ status: 'agendado' }); const b = await cenario({ status: 'cancelado' });
  const c = await cenario(); await db.query(`update public.pre_agendamentos set criado_em = now() - interval '20 days' where id = $1`, [c.pre]);
  await rodar();
  return { ok: (await ler(a.pre)).cs === null && (await ler(b.pre)).status === 'cancelado' && (await ler(c.pre)).status === 'pronto' };
});

await caso('prontuário do chat ("conv:") nunca serve como paciente do Klingo', async () => {
  const { pre } = await cenario({ prontuario: 'conv:abc' });
  await rodar(); return { ok: (await ler(pre)).status === 'pronto' };
});

await caso('chave config.agendamento_reconhecer = nao desliga a gravação', async () => {
  await db.query(`update public.config set valor = 'nao' where chave = 'agendamento_reconhecer'`);
  const { pre } = await cenario(); const r = await rodar(); const l = await ler(pre);
  await db.query(`update public.config set valor = 'sim' where chave = 'agendamento_reconhecer'`);
  return { ok: r.desligado === true && l.status === 'pronto' };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
