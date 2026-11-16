// FLUXOGRAMA: entrada (o retrato da produção + supabase/pedido-marcacao-klingo.sql; conversas abertas pelo motor REAL do chat; pedido "agendado" com o número da marcação em pre_agendamentos.klingo_marcacoes; a marcação do Klingo num cartão SEM conversa, como a Jornada faz) -> validação (só entra a marcação guardada no próprio pedido; remarcada fica fora; outro paciente nunca vê a marcação alheia) -> lógica (a situação real do Klingo substitui o "pedido" parado: A confirmar = 2, Confirmado = 3, atendido = 5, cancelado = exceção; resultado, remarcar e cancelar acham o exame) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (corrige o "Pedido" que não saía do lugar depois do agendamento feito pelo chat)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, anonimo } = ajudantes(db);
const sql = readFileSync(`${REPO}/supabase/pedido-marcacao-klingo.sql`, 'utf8');
const reversao = readFileSync(`${REPO}/supabase/pedido-marcacao-klingo-rollback.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await db.exec(`insert into public.config (chave, valor) values ('app_acesso_modo', 'sim') on conflict (chave) do update set valor = 'sim'`);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste'), ('klingo_interno_segredo', 'segredo-de-teste') on conflict (name) do nothing`);
await db.exec(`insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('agendado', 'Agendado', 0, 'agendamento', 'klingo'), ('a_confirmar', 'A confirmar', 1, 'agendamento', 'klingo'), ('confirmado', 'Confirmado', 2, 'agendamento', 'klingo'), ('chegou', 'Chegou', 3, 'depois', 'klingo'), ('em_atendimento', 'Em atendimento', 4, 'depois', 'klingo'), ('cancelado', 'Cancelado', 90, 'excecao', 'klingo') on conflict do nothing`);

const rpc = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
const hoje = (await q(`select (now() at time zone 'America/Sao_Paulo')::date::text d`))[0].d;
const amanha = (await q(`select ((now() at time zone 'America/Sao_Paulo')::date + 1)::text d`))[0].d;

// Cria um paciente com acesso rápido e UMA conversa dele com pedido "agendado" (marcação do Klingo guardada no pedido)
let seq = 0;
async function paciente(rotulo) {
  seq++;
  const tel = `7199123${String(1000 + seq)}`;
  const p = await rpc('app_cadastrar', { p_telefone: tel, p_nome: `${rotulo} Teste`, p_nascimento: '1988-04-12', p_pin: '1357', p_filhos: [], p_aparelho: 'teste' + seq });
  await q(`update public.conversas set criado_em = criado_em - interval '2 hours' where id not in (select conversa_id from public.app_conversa)`);
  const ini = await rpc('chat_iniciar', { p_nome: `${rotulo} Teste`, p_telefone: tel, p_email: `p${seq}@exemplo.invalid`, p_aceite: true, p_paciente_tipo: 'proprio' });
  await rpc('app_conversa_vincular', { p_token: p.token, p_conversa: ini.conversa_id, p_conv_token: ini.token });
  return { tok: p.token, conversa: ini.conversa_id };
}
// cartão da conversa com o pedido parado + cartão do Klingo SEM conversa com a marcação real
async function agendar(pac, marcacao, { status, confirm = 'A Confirmar', para = `${amanha}`, hora = 16, preStatus = 'agendado', checkin = null, atend = null, marcacoes = [marcacao] }) {
  const chave = `conv:${pac.conversa}`;
  const own = (await q(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna, conversa_id) values ($1, $2, 'Centro', 'agendado', $3) returning id`, [chave, hoje, pac.conversa]))[0].id;
  await q(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, status, unidade) values ($1, $2, 'RX POLEGAR', 'pedido', 'Centro')`, [own, `item:${marcacao}`]);
  const kl = (await q(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna) values ($1, $2, 'Centro', $3) returning id`, [`n:${marcacao}`, para, status === 'confirmado' ? 'confirmado' : status === 'atendido' ? 'em_atendimento' : status === 'cancelado' ? 'cancelado' : 'a_confirmar']))[0].id;
  await q(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, status, confirm_status, unidade, atendimento_id, agendado_para, checkin_em)
    values ($1, $2, 'RX POLEGAR', $3, $4, 'Centro', $5, ((($6::date)::timestamp + make_interval(hours => $7)) at time zone 'America/Sao_Paulo'), ${checkin ? `((($6::date)::timestamp + interval '${checkin}') at time zone 'America/Sao_Paulo')` : 'null'})`,
    [kl, 'm' + marcacao, status, confirm, atend, para, hora]);
  await q(`update public.pre_agendamentos set status = $2, klingo_marcacoes = $3::text[] where conversa_id = $1`, [pac.conversa, preStatus, marcacoes]);
  if (!(await q(`select 1 from public.pre_agendamentos where conversa_id = $1`, [pac.conversa])).length)
    await q(`insert into public.pre_agendamentos (conversa_id, tipo, status, procedimento, klingo_marcacoes) values ($1, 'exame', $2, 'RX POLEGAR', $3::text[])`, [pac.conversa, preStatus, marcacoes]);
}
const exames = async (pac) => { const r = await rpc('app_pedidos', { p_token: pac.tok, p_renova: true }); return (r.pedidos || []).flatMap((p) => p.exames || []); };

// ---- ANTES de aplicar: o defeito (prova de que o teste enxerga o problema). O retrato já traz a correção, então primeiro volta ao estado antigo pelo arquivo de reversão.
await caso('o arquivo de reversão aplica sem erro (volta ao estado de 15/11/2026)', async () => { await db.exec(reversao); return { ok: true }; });
const antes = await paciente('Antes');
await agendar(antes, '9301', { status: 'confirmado', confirm: 'Confirmado' });
await caso('ANTES da correção: o pedido agendado e confirmado no Klingo aparece parado em "Pedido" (ok 1)', async () => {
  const ex = await exames(antes);
  return { ok: ex.length === 1 && ex[0].ok === 1, detalhe: JSON.stringify(ex.map((e) => ({ ok: e.ok, voucher: e.voucher }))) };
});
await caso('pedido-marcacao-klingo.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

// ---- DEPOIS
await caso('DEPOIS: o mesmo pedido mostra Confirmado (ok 3) com o número da marcação, data e hora; um exame só (sem o "pedido" repetido)', async () => {
  const ex = await exames(antes);
  return { ok: ex.length === 1 && ex[0].ok === 3 && ex[0].voucher === '9301' && ex[0].data === amanha && ex[0].hora === '16:00' && !ex[0].excecao, detalhe: JSON.stringify(ex) };
});
const ac = await paciente('Aconfirmar');
await agendar(ac, '9302', { status: 'agendado', confirm: 'A Confirmar' });
await caso('Klingo "A Confirmar" vira ok 2 (marcado, falta confirmar)', async () => {
  const ex = await exames(ac); return { ok: ex.length === 1 && ex[0].ok === 2 && ex[0].voucher === '9302', detalhe: JSON.stringify(ex) };
});
const ch = await paciente('Chegou');
await agendar(ch, '9303', { status: 'confirmado', confirm: 'Confirmado', para: hoje, hora: 8, checkin: '7 hours 50 minutes' });
await caso('check-in do dia do exame vira Chegada (ok 4) e mostra a hora', async () => {
  const ex = await exames(ch); return { ok: ex.length === 1 && ex[0].ok === 4 && ex[0].chegada === '07:50', detalhe: JSON.stringify(ex) };
});
const at = await paciente('Atendido');
await agendar(at, '9304', { status: 'atendido', confirm: 'Confirmado', para: hoje, hora: 8, atend: '444' });
await caso('atendido no Klingo vira ok 5', async () => {
  const ex = await exames(at); return { ok: ex.length === 1 && ex[0].ok === 5, detalhe: JSON.stringify(ex) };
});
await caso('exame atendido: "pedir resultado" acha o exame da marcação do Klingo (antes dizia que não estava realizado)', async () => {
  const ex = await exames(at);
  const r = await rpc('app_pedido_acao', { p_token: at.tok, p_conversa: at.conversa, p_acao: 'resultado', p_exame: ex[0].id });
  return { ok: r && r.ok === true && r.erro !== 'exame', detalhe: JSON.stringify(r).slice(0, 200) };
});
const ca = await paciente('Cancelado');
await agendar(ca, '9305', { status: 'cancelado', confirm: 'A Confirmar' });
await caso('cancelado no Klingo aparece como cancelado (exceção), sem passos', async () => {
  const ex = await exames(ca); return { ok: ex.length === 1 && ex[0].excecao === 'cancelado' && ex[0].ok === null, detalhe: JSON.stringify(ex) };
});
const re = await paciente('Remarcado');
await agendar(re, '9306', { status: 'remarcado', confirm: 'A Confirmar' });
await caso('marcação remarcada no Klingo não entra: o pedido continua como estava (ok 1), sem inventar horário', async () => {
  const ex = await exames(re); return { ok: ex.length === 1 && ex[0].ok === 1 && ex[0].voucher === null, detalhe: JSON.stringify(ex) };
});
const sp = await paciente('SemPreAgendado');
await agendar(sp, '9307', { status: 'confirmado', confirm: 'Confirmado', preStatus: 'pronto', marcacoes: [] });
await caso('pedido SEM número de marcação guardado (pronto, ainda não agendado) continua como antes: ok 1', async () => {
  const ex = await exames(sp); return { ok: ex.length === 1 && ex[0].ok === 1, detalhe: JSON.stringify(ex) };
});
await caso('privacidade: um paciente nunca vê a marcação de outro (cada um só vê a marcação guardada no seu pedido)', async () => {
  const a = await exames(antes), b = await exames(ac);
  return { ok: a.every((e) => e.voucher === '9301') && b.every((e) => e.voucher === '9302') && !(await exames(sp)).some((e) => e.voucher), detalhe: JSON.stringify([a.map((e) => e.voucher), b.map((e) => e.voucher)]) };
});
await caso('marcação de outra pessoa não vira o pedido de quem não a tem: exame fora do pedido não é aceito em "pedir resultado"', async () => {
  const ex = await exames(at);
  const r = await rpc('app_pedido_acao', { p_token: sp.tok, p_conversa: sp.conversa, p_acao: 'resultado', p_exame: ex[0].id });
  return { ok: r && r.ok === false && r.erro === 'exame', detalhe: JSON.stringify(r).slice(0, 200) };
});

const falhou = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhou} de ${resultados.length} passaram.`);
process.exit(falhou ? 1 : 0);
