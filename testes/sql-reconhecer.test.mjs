// FLUXOGRAMA: entrada (supabase/agendamento-reconhecer.sql, as funções reais norm_nome e tabelas mínimas do chat e da Jornada, num Postgres embutido) -> validação (conversa aberta + NOME COMPLETO no Klingo; marcação feita depois da conversa; exame agendado/confirmado e futuro) -> lógica (vira agendado com os dados reais do Klingo, manda a confirmação ao paciente, sinaliza divergência sem bloquear, não mexe em conversa encerrada, ambíguo só alerta) -> saída (PASS/FAIL por caso).
// Versão 2.0 — 10/11/2026 / Mudança: regra decidida pelo dono (WC-02): basta conversa aberta e nome completo no Klingo
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
  create table public.pre_agendamento_itens (id bigint generated always as identity primary key, conversa_id uuid, procedimento text, ativo boolean default true);
  create table public.jornada_paciente (prontuario text primary key, nome text, fone_chave text);
  create table public.jornada_card (id bigint generated always as identity primary key, paciente_chave text, arquivado_em timestamptz);
  create table public.jornada_exame (id bigint generated always as identity primary key, card_id bigint, procedimento text, unidade text, status text, agendado_para timestamptz, agendado_em timestamptz);
`);
const sql = readFileSync(`${REPO}/supabase/agendamento-reconhecer.sql`, 'utf8');
await caso('o arquivo aplica sem erro e pode ser aplicado de novo', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

let seq = 0;
const futuro = (dias, hora = '11:00') => new Date(Date.parse(`2099-01-01T${hora}:00Z`) + dias * 86400000).toISOString();   // sempre no futuro
const dia = (dias) => futuro(dias).slice(0, 10);
// Cenário: conversa criada às 12:50 UTC de 09/11; Klingo marcado às 12:57 do mesmo dia. Chat escolheu o dia/hora local (Brasília = UTC-3).
async function cenario({ nomeChat, nomeKlingo, convStatus = 'em_atendimento', status = 'pronto', itens = ['CONSULTA'], prontuario = null, extraProntuario = null,
  escolha = null, exames = null, detalhe = null } = {}) {
  seq++; const letras = String(seq).replace(/\d/g, (d) => 'ABCDEFGHIJ'[d]);   // a normalização do nome só guarda letras
  const base = `Paciente Teste Numero${letras} Sobrenome`;
  nomeChat = nomeChat ?? base; nomeKlingo = nomeKlingo ?? base.toUpperCase();
  prontuario = prontuario ?? 'P' + seq + Math.floor(Math.random() * 1e6);
  escolha = escolha ?? [{ data: dia(30), hora: '08:00', min: 15, chegada: false, profissional: 'CAMILA CARINE', unidade: 'DESENVOAR' }];
  exames = exames ?? [{ proc: 'CONSULTA', para: futuro(30, '11:00'), em: '2026-11-09T12:57:00Z', status: 'agendado', unidade: 'CSI Pediatria' }];
  const ct = (await db.query(`insert into public.contatos (nome, telefone) values ('Responsável', $1) returning id`, ['7199' + String(1e6 + seq)])).rows[0].id;
  const c = (await db.query(`insert into public.conversas (status, contato_id, criado_em) values ($1, $2, '2026-11-09T12:50:00Z') returning id`, [convStatus, ct])).rows[0].id;
  const pre = (await db.query(`insert into public.pre_agendamentos (conversa_id, status, criado_em, paciente, escolha_horario, conferencia_detalhe) values ($1, $2, now(), $3, $4, $5) returning id`,
    [c, status, JSON.stringify({ nome: nomeChat }), JSON.stringify(escolha), detalhe])).rows[0].id;
  for (const i of itens) await db.query(`insert into public.pre_agendamento_itens (conversa_id, procedimento) values ($1, $2)`, [c, i]);
  for (const pr of [prontuario, extraProntuario].filter(Boolean)) {
    await db.query(`insert into public.jornada_paciente values ($1, $2, null)`, [pr, nomeKlingo]);
    const k = (await db.query(`insert into public.jornada_card (paciente_chave) values ($1) returning id`, [pr])).rows[0].id;
    for (const e of exames) await db.query(`insert into public.jornada_exame (card_id, procedimento, unidade, status, agendado_para, agendado_em) values ($1, $2, $3, $4, $5, $6)`, [k, e.proc, e.unidade ?? 'CSI 1', e.status, e.para, e.em]);
  }
  return { c, pre };
}
const ler = async (pre) => (await db.query(`select status, conferencia_status cs, conferencia_via via, escolha_horario esc, escolha_horario_chat chat, confirmacao_enviada_em is not null enviada from public.pre_agendamentos where id = $1`, [pre])).rows[0];
const msgs = async (c) => (await db.query(`select texto from public.mensagens where conversa_id = $1 order by id`, [c])).rows.map((r) => r.texto);
const alerta = async (c) => (await db.query(`select alerta_agenda a from public.conversas where id = $1`, [c])).rows[0].a;
const rodar = async (aplicar = true) => (await db.query(`select public.agendamento_reconhecer_klingo($1) r`, [aplicar])).rows[0].r;

await caso('conversa aberta + nome completo no Klingo: vira agendado com os dados REAIS do Klingo (data, hora, unidade), guarda a previsão e manda a confirmação', async () => {
  const { c, pre } = await cenario({ exames: [{ proc: 'CONSULTA', para: futuro(40, '11:00'), em: '2026-11-09T12:57:00Z', status: 'agendado', unidade: 'CSI Pediatria' }] });   // chat: dia 30 às 08:00; Klingo: dia 40 às 08:00 (11:00Z)
  await rodar(); const l = await ler(pre); const m = await msgs(c);
  return { ok: l.status === 'agendado' && l.cs === 'confirmado' && l.via === 'nome' && l.enviada && l.esc[0].data === dia(40) && l.esc[0].hora === '08:00' && l.esc[0].origem === 'klingo'
    && l.chat[0].data === dia(30) && m.length === 1 && /Boa notícia/.test(m[0]) && new RegExp(`${dia(40).slice(8, 10)}/${dia(40).slice(5, 7)} às 08:00`).test(m[0]) && /CSI Pediatria/.test(m[0]), detalhe: m[0]?.replace(/\n/g, ' | ').slice(0, 160) };
});

await caso('divergência (data diferente) NÃO bloqueia: agenda e só sinaliza a atendente', async () => {
  const { c, pre } = await cenario({ exames: [{ proc: 'CONSULTA', para: futuro(41, '11:00'), em: '2026-11-09T12:57:00Z', status: 'confirmado' }] });
  await rodar();
  return { ok: (await ler(pre)).status === 'agendado' && /pode encerrar a conversa/.test((await alerta(c)) || '') };
});

await caso('tudo batendo (data, hora, exame): agenda, confirma e NÃO sinaliza', async () => {
  const { c, pre } = await cenario({ escolha: [{ data: dia(30), hora: '08:00', min: 15, chegada: false, profissional: 'CAMILA CARINE', unidade: 'DESENVOAR' }], exames: [{ proc: 'CONSULTA', para: futuro(30, '11:00'), em: '2026-11-09T12:57:00Z', status: 'agendado' }] });
  await rodar();
  return { ok: (await ler(pre)).status === 'agendado' && (await alerta(c)) === null && (await msgs(c)).length === 1 };
});

await caso('exame diferente do pedido: agenda e sinaliza', async () => {
  const { c, pre } = await cenario({ itens: ['RM DE JOELHO'], exames: [{ proc: 'CONSULTA', para: futuro(30, '11:00'), em: '2026-11-09T12:57:00Z', status: 'agendado' }] });
  await rodar();
  return { ok: (await ler(pre)).status === 'agendado' && !!(await alerta(c)) };
});

await caso('médico diferente (conhecido pela conferência automática): agenda, mostra o médico na mensagem e sinaliza', async () => {
  const { c, pre } = await cenario({ detalhe: `Este paciente tem CONSULTA (S) marcado em ${(() => { const d = futuro(30, '11:00'); return d.slice(8, 10) + '/' + d.slice(5, 7); })()} 08:00 (MAIRA SUELI SOUZA, DESENVOAR), diferente do horário escolhido no chat.` });
  await rodar(); const m = await msgs(c);
  return { ok: (await ler(pre)).status === 'agendado' && /com MAIRA SUELI SOUZA/.test(m[0]) && !!(await alerta(c)), detalhe: m[0]?.split('\n').slice(-3).join(' | ').slice(0, 140) };
});

await caso('conversa ENCERRADA não é tocada: sem agendar, sem mensagem', async () => {
  const { c, pre } = await cenario({ convStatus: 'encerrada' });
  await rodar(); return { ok: (await ler(pre)).status === 'pronto' && (await msgs(c)).length === 0 };
});

await caso('nome incompleto (só primeiro e último) NÃO conta; o nome completo, sim', async () => {
  const a = await cenario({ nomeChat: 'Beatriz Almeida Souza Lima Q', nomeKlingo: 'BEATRIZ LIMA' });
  const b = await cenario({ nomeChat: 'Beatriz Almeida Souza Lima Q', nomeKlingo: 'BEATRIZ ALMEIDA SOUZA' });
  const c = await cenario({ nomeChat: 'Beatriz Almeida Souza Lima Z', nomeKlingo: 'Beatriz  ALMEIDA souza lima z' });   // acento, caixa e espaço sobrando
  await rodar();
  return { ok: (await ler(a.pre)).status === 'pronto' && (await ler(b.pre)).status === 'pronto' && (await ler(c.pre)).status === 'agendado' };
});

await caso('o telefone NÃO é exigido (só o nome completo)', async () => {
  const { pre } = await cenario(); await rodar(); return { ok: (await ler(pre)).status === 'agendado' };
});

await caso('dois cadastros com o mesmo nome completo: não escolhe, só alerta a atendente', async () => {
  const { c, pre } = await cenario({ extraProntuario: 'Pdup' + Math.floor(Math.random() * 1e6) });
  const r = await rodar();
  return { ok: (await ler(pre)).status === 'pronto' && /mais de um cadastro/.test((await alerta(c)) || '') && r.ambiguos >= 1 && (await msgs(c)).length === 0 };
});

await caso('marcação feita ANTES da conversa, cancelada, atendida ou já passada: não conta', async () => {
  const a = await cenario({ exames: [{ proc: 'CONSULTA', para: futuro(30), em: '2026-11-01T10:00:00Z', status: 'agendado' }] });
  const b = await cenario({ exames: [{ proc: 'CONSULTA', para: futuro(30), em: '2026-11-09T12:57:00Z', status: 'cancelado' }] });
  const c = await cenario({ exames: [{ proc: 'CONSULTA', para: futuro(30), em: '2026-11-09T12:57:00Z', status: 'atendido' }] });
  const d = await cenario({ exames: [{ proc: 'CONSULTA', para: '2026-11-08T11:00:00Z', em: '2026-11-09T12:57:00Z', status: 'agendado' }] });   // já passou
  await rodar();
  return { ok: [a, b, c, d].every(async (x) => true) && (await ler(a.pre)).status === 'pronto' && (await ler(b.pre)).status === 'pronto' && (await ler(c.pre)).status === 'pronto' && (await ler(d.pre)).status === 'pronto' };
});

await caso('rascunho: só quando há atendente na conversa; com o assistente ainda montando o pedido, não', async () => {
  const bot = await cenario({ status: 'rascunho', convStatus: 'aguardando' }); const gente = await cenario({ status: 'rascunho', convStatus: 'em_atendimento' });
  await rodar();
  return { ok: (await ler(bot.pre)).status === 'rascunho' && (await ler(gente.pre)).status === 'agendado' };
});

await caso('vários exames no Klingo: todos entram na mensagem e no horário real', async () => {
  const { c, pre } = await cenario({ exames: [{ proc: 'CONSULTA', para: futuro(30, '11:00'), em: '2026-11-09T12:57:00Z', status: 'agendado' }, { proc: 'CONSULTA NEUROPEDIATRIA', para: futuro(45, '12:20'), em: '2026-11-09T13:50:00Z', status: 'agendado' }] });
  await rodar(); const l = await ler(pre); const m = await msgs(c);
  return { ok: l.esc.length === 2 && /CONSULTA:/.test(m[0]) && /NEUROPEDIATRIA/.test(m[0]) && (m[0].match(/•/g) || []).length === 2 };
});

await caso('rodar de novo não manda outra mensagem nem muda nada; quem já está agendado não é tocado', async () => {
  const { c, pre } = await cenario(); await rodar(); const antes = await ler(pre); const r2 = await rodar();
  return { ok: JSON.stringify(antes) === JSON.stringify(await ler(pre)) && (await msgs(c)).length === 1 && !r2.ids.includes(pre) };
});

await caso('simulação (false) conta e devolve os ids, sem gravar nem mandar mensagem', async () => {
  const { c, pre } = await cenario(); const r = await rodar(false);
  return { ok: r.aplicado === false && r.ids.includes(pre) && (await ler(pre)).status === 'pronto' && (await msgs(c)).length === 0 };
});

await caso('chave config.agendamento_reconhecer = nao desliga', async () => {
  await db.query(`update public.config set valor = 'nao' where chave = 'agendamento_reconhecer'`);
  const { pre } = await cenario(); const r = await rodar(); const l = await ler(pre);
  await db.query(`update public.config set valor = 'sim' where chave = 'agendamento_reconhecer'`);
  return { ok: r.desligado === true && l.status === 'pronto' };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
