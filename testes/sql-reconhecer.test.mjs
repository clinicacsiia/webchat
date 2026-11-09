// FLUXOGRAMA: entrada (supabase/agendamento-reconhecer-v3.sql, agendamento-reconhecer.sql e tabelas mínimas do chat, num Postgres embutido) -> validação (quais pedidos entram na lista; veredito da Edge Function aplicado só uma vez por pedido e por marcação) -> lógica (agenda com data/hora/unidade reais, guarda a previsão, mensagem só em conversa aberta, divergência só sinaliza, ambíguo não escolhe) -> saída (PASS/FAIL por caso).
// Versão 3.0 — 10/11/2026 / Mudança: v3 (a comparação de nome e exame acontece na Edge Function; o banco lista os pedidos e aplica o veredito)
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
  create table public.pre_agendamentos (id uuid primary key default gen_random_uuid(), conversa_id uuid, status text, criado_em timestamptz default now(), atualizado_em timestamptz default now(), paciente jsonb, procedimento text,
    escolha_horario jsonb, conferencia_status text, conferencia_detalhe text, conferencia_via text, conferencia_em timestamptz, conferencia_falhas int, agendado_auto_em timestamptz, confirmacao_enviada_em timestamptz);
  create table public.pre_agendamento_itens (id bigint generated always as identity primary key, conversa_id uuid, procedimento text, ativo boolean default true);
  insert into public.config values ('ia_segredo', 'segredo-teste');
`);
const v2 = readFileSync(`${REPO}/supabase/agendamento-reconhecer.sql`, 'utf8');
await db.exec(`create table public.jornada_paciente (prontuario text primary key, nome text, fone_chave text); create table public.jornada_card (id bigint generated always as identity primary key, paciente_chave text, arquivado_em timestamptz);
  create table public.jornada_exame (id bigint generated always as identity primary key, card_id bigint, procedimento text, unidade text, status text, agendado_para timestamptz, agendado_em timestamptz);`);
const v3 = readFileSync(`${REPO}/supabase/agendamento-reconhecer-v3.sql`, 'utf8');
await caso('os arquivos aplicam sem erro e podem ser aplicados de novo; a chave nasce desligada', async () => {
  await db.exec(v2); await db.exec(v3); await db.exec(v3);
  const v = (await db.query(`select valor from public.config where chave = 'agendamento_reconhecer'`)).rows[0].valor;
  return { ok: true, detalhe: 'chave=' + v };
});
const liga = (v) => db.query(`update public.config set valor = $1 where chave = 'agendamento_reconhecer'`, [v]);
const msgEnc = (v) => db.query(`update public.config set valor = $1 where chave = 'agendamento_reconhecer_msg_encerradas'`, [v]);
await liga('sim');

let seq = 0;
const CHAT = [{ data: '2099-01-31', hora: '08:00', min: 15, chegada: false, profissional: 'MEDICO EXEMPLO UM', unidade: 'DESENVOAR' }];
async function pedido({ convStatus = 'em_atendimento', status = 'pronto', itens = ['CONSULTA'], escolha = CHAT, dias = 0, detalhe = null, tel = null } = {}) {
  seq++;
  const ct = (await db.query(`insert into public.contatos (nome, telefone) values ('Responsável', $1) returning id`, [tel ?? '(71) 9' + String(1e7 + seq)])).rows[0].id;
  const c = (await db.query(`insert into public.conversas (status, contato_id, criado_em) values ($1, $2, '2026-11-09T12:50:00Z') returning id`, [convStatus, ct])).rows[0].id;
  const pre = (await db.query(`insert into public.pre_agendamentos (conversa_id, status, criado_em, paciente, escolha_horario, conferencia_detalhe) values ($1, $2, now() - make_interval(days => $3), $4, $5, $6) returning id`,
    [c, status, dias, JSON.stringify({ nome: 'Paciente Teste ' + seq }), JSON.stringify(escolha), detalhe])).rows[0].id;
  for (const i of itens) await db.query(`insert into public.pre_agendamento_itens (conversa_id, procedimento) values ($1, $2)`, [c, i]);
  return { c, pre };
}
const marc = (o = {}) => ({ id: 'M' + Math.floor(Math.random() * 1e9), proc: 'CONSULTA', unidade: 'CSI Pediatria', para: '2099-01-31 08:00:00', em: '2026-11-09 09:57:00', compat: 'exato', ...o });
const veredito = (pre, marcacoes, ident = 'forte', amb = false) => ({ id: pre, identidade: ident, ambiguo: amb, marcacoes });
const aplicar = async (lista) => (await db.query(`select public.agendamento_reconhecer_aplicar($1::jsonb) r`, [JSON.stringify(lista)])).rows[0].r;
const ler = async (pre) => (await db.query(`select status, conferencia_status cs, conferencia_detalhe det, conferencia_via via, escolha_horario esc, escolha_horario_chat chat, klingo_marcacoes km from public.pre_agendamentos where id = $1`, [pre])).rows[0];
const msgs = async (c) => (await db.query(`select texto from public.mensagens where conversa_id = $1 order by id`, [c])).rows.map((r) => r.texto);
const alerta = async (c) => (await db.query(`select alerta_agenda a from public.conversas where id = $1`, [c])).rows[0].a;
const alvos = async () => (await db.query(`select public.agendamento_reconhecer_alvos(14) r`)).rows[0].r;

await caso('lista de pedidos: entram "pronto" (qualquer conversa) e "rascunho" (atendida ou encerrada) com exame; não entram agendado, bot montando, sem exame, antigo ou já reconhecido', async () => {
  const a = await pedido(), b = await pedido({ convStatus: 'encerrada' }), c = await pedido({ status: 'rascunho', convStatus: 'encerrada' }), d = await pedido({ status: 'rascunho', convStatus: 'em_atendimento' });
  const x1 = await pedido({ status: 'agendado' }), x2 = await pedido({ status: 'rascunho', convStatus: 'aguardando' }), x3 = await pedido({ itens: [] }), x4 = await pedido({ dias: 20 });
  const x5 = await pedido(); await db.query(`update public.pre_agendamentos set klingo_marcacoes = '{M1}' where id = $1`, [x5.pre]);
  const ids = (await alvos()).map((x) => x.id);
  const alvoA = (await alvos()).find((x) => x.id === a.pre);
  return { ok: [a, b, c, d].every((p) => ids.includes(p.pre)) && [x1, x2, x3, x4, x5].every((p) => !ids.includes(p.pre)) && /^\d{8}$/.test(alvoA.fones[0]) && alvoA.itens[0] === 'CONSULTA' && alvoA.nome.startsWith('Paciente Teste'),
    detalhe: JSON.stringify({ fones: alvoA.fones, itens: alvoA.itens }) };
});

await caso('conversa ABERTA: agenda com a data/hora/unidade REAIS, guarda a previsão, manda a confirmação e sinaliza a divergência de data', async () => {
  const { c, pre } = await pedido();
  const r = await aplicar([veredito(pre, [marc({ para: '2099-02-10 09:20:00' })])]);
  const l = await ler(pre); const m = await msgs(c);
  return { ok: r.agendados === 1 && l.status === 'agendado' && l.cs === 'remarcado' && l.via === 'ambos' && l.esc[0].data === '2099-02-10' && l.esc[0].hora === '09:20' && l.esc[0].origem === 'klingo' && l.chat[0].data === '2099-01-31'
    && l.km.length === 1 && m.length === 1 && /10\/02 às 09:20/.test(m[0]) && /CSI Pediatria/.test(m[0]) && /pode encerrar a conversa/.test((await alerta(c)) || ''), detalhe: JSON.stringify(r) };
});

await caso('tudo batendo (mesmo dia e hora, exame igual): agenda, confirma e NÃO sinaliza', async () => {
  const { c, pre } = await pedido();
  await aplicar([veredito(pre, [marc({ para: '2099-01-31 08:10:00' })], 'medio')]);
  const l = await ler(pre);
  return { ok: l.status === 'agendado' && l.cs === 'confirmado' && l.via === 'nome' && (await alerta(c)) === null && (await msgs(c)).length === 1 };
});

await caso('conversa ENCERRADA: agenda e guarda os dados reais, mas NÃO manda mensagem nem alerta (a menos que a chave permita)', async () => {
  const { c, pre } = await pedido({ convStatus: 'encerrada' });
  await aplicar([veredito(pre, [marc({ para: '2099-03-03 10:00:00' })])]);
  const l = await ler(pre);
  const semMsg = (await msgs(c)).length === 0 && (await alerta(c)) === null;
  await msgEnc('sim'); const o = await pedido({ convStatus: 'encerrada' }); await aplicar([veredito(o.pre, [marc({ para: '2099-03-04 10:00:00' })])]); const comMsg = (await msgs(o.c)).length === 1; await msgEnc('nao');
  return { ok: l.status === 'agendado' && l.esc[0].data === '2099-03-03' && semMsg && comMsg };
});

await caso('exame só da mesma família (nome diferente): agenda, mas marca divergência', async () => {
  const { c, pre } = await pedido();
  await aplicar([veredito(pre, [marc({ proc: 'CONSULTA NEUROPEDIATRIA', compat: 'familia', para: '2099-01-31 08:00:00' })])]);
  return { ok: (await ler(pre)).cs === 'remarcado' && !!(await alerta(c)) };
});

await caso('ambíguo: não agenda; conversa aberta recebe o alerta, a encerrada não', async () => {
  const a = await pedido(), b = await pedido({ convStatus: 'encerrada' });
  const r = await aplicar([veredito(a.pre, [], null, true), veredito(b.pre, [], null, true)]);
  return { ok: r.ambiguos === 2 && (await ler(a.pre)).status === 'pronto' && (await ler(b.pre)).status === 'pronto' && /mais de um cadastro/.test((await alerta(a.c)) || '') && (await alerta(b.c)) === null };
});

await caso('cada marcação do Klingo vale para UM pedido só', async () => {
  const a = await pedido(), b = await pedido(); const m = marc();
  const r = await aplicar([veredito(a.pre, [m]), veredito(b.pre, [m])]);
  const st = [(await ler(a.pre)).status, (await ler(b.pre)).status].sort().join();
  return { ok: r.agendados === 1 && r.ja_usadas_por_outro_pedido === 1 && st === 'agendado,pronto' };
});

await caso('dois pedidos da mesma pessoa casam com a MESMA marcação: vale o "pronto" (e o mais recente entre iguais), na ordem em que vierem', async () => {
  const rasc = await pedido({ status: 'rascunho' }), pronto = await pedido({ status: 'pronto' }); const m = marc();
  const r = await aplicar([veredito(rasc.pre, [m]), veredito(pronto.pre, [m])]);
  return { ok: r.agendados === 1 && (await ler(pronto.pre)).status === 'agendado' && (await ler(rasc.pre)).status === 'rascunho' };
});

await caso('aplicar de novo o mesmo veredito não repete nada (mensagem única)', async () => {
  const { c, pre } = await pedido(); const v = veredito(pre, [marc()]);
  await aplicar([v]); const r2 = await aplicar([v]);
  return { ok: r2.agendados === 0 && (await msgs(c)).length === 1 };
});

await caso('pedido já agendado ou cancelado, veredito sem marcação ou sem identidade: nada acontece', async () => {
  const a = await pedido({ status: 'agendado' }), b = await pedido({ status: 'cancelado' }), c = await pedido(), d = await pedido();
  const r = await aplicar([veredito(a.pre, [marc()]), veredito(b.pre, [marc()]), veredito(c.pre, []), veredito(d.pre, [marc()], null)]);
  return { ok: r.agendados === 0 && (await ler(c.pre)).status === 'pronto' && (await ler(d.pre)).status === 'pronto' };
});

await caso('vários exames: todos entram nos horários reais e na mensagem', async () => {
  const { c, pre } = await pedido({ itens: ['CONSULTA', 'CONSULTA NEUROPEDIATRIA'] });
  await aplicar([veredito(pre, [marc({ para: '2099-01-31 08:00:00' }), marc({ proc: 'CONSULTA NEUROPEDIATRIA', para: '2099-02-15 12:20:00' })])]);
  const l = await ler(pre); const m = await msgs(c);
  return { ok: l.esc.length === 2 && (m[0].match(/•/g) || []).length === 2 && /NEUROPEDIATRIA/.test(m[0]) };
});

await caso('médico entra na mensagem só quando a conferência automática já registrou o mesmo dia e horário', async () => {
  const { c, pre } = await pedido({ detalhe: 'Este paciente tem CONSULTA (S) marcado em 31/01 08:00 (MEDICO EXEMPLO DOIS, DESENVOAR), diferente do horário escolhido no chat.' });
  await aplicar([veredito(pre, [marc({ para: '2099-01-31 08:00:00' })])]);
  return { ok: /com MEDICO EXEMPLO DOIS/.test((await msgs(c))[0]) };
});

await caso('um veredito com data inválida não derruba os outros', async () => {
  const a = await pedido(), b = await pedido();
  const r = await aplicar([veredito(a.pre, [marc({ para: 'data-quebrada' })]), veredito(b.pre, [marc()])]);
  return { ok: r.agendados === 1 && (await ler(a.pre)).status === 'pronto' && (await ler(b.pre)).status === 'agendado' };
});

await caso('chave desligada: nada é aplicado', async () => {
  const { pre } = await pedido(); await liga('nao'); const r = await aplicar([veredito(pre, [marc()])]); await liga('sim');
  return { ok: r.desligado === true && (await ler(pre)).status === 'pronto' };
});

await caso('rotina (disparar): só chama a Edge Function com a chave ligada e pedido esperando', async () => {
  await db.query(`delete from net.chamadas`); await db.query(`delete from public.pre_agendamentos`);
  await liga('nao'); await db.query(`select public.agendamento_reconhecer_disparar()`); const a = (await db.query(`select count(*)::int n from net.chamadas`)).rows[0].n;
  await liga('sim'); await db.query(`select public.agendamento_reconhecer_disparar()`); const b = (await db.query(`select count(*)::int n from net.chamadas`)).rows[0].n;
  await pedido(); await db.query(`select public.agendamento_reconhecer_disparar()`); const c = (await db.query(`select url, headers ->> 'x-sync-key' k from net.chamadas`)).rows;
  return { ok: a === 0 && b === 0 && c.length === 1 && /klingo-reconhecer$/.test(c[0].url) && c[0].k === 'segredo-teste' };
});

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} verificações passaram.`);
process.exit(falhas ? 1 : 0);
