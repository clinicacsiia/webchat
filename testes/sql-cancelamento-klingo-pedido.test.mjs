// FLUXOGRAMA: entrada (o retrato da produção + supabase/cancelamento-klingo-pedido.sql; pedidos do chat "agendado" com o número da marcação em pre_agendamentos.klingo_marcacoes; linhas do lote do Klingo inventadas) -> validação (só fecha o pedido quando TODAS as marcações dele estão canceladas na Jornada; remarcada, atendida ou ativa não fecham; pedido que não está "agendado" não é tocado) -> lógica (jornada_klingo_lote chama pedido_fechar_cancelado_klingo: o pedido vira cancelado, a marcação do Klingo vira cancelada, o alerta "Marcação sumiu do Klingo" sai, fica uma nota interna; repetir o lote não faz nada de novo) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (cancelamento feito direto no Klingo chega ao pedido do chat e some do "Exame em aberto" do painel; webhook do Klingo ainda desligado)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, anonimo } = ajudantes(db);
const sql = readFileSync(`${REPO}/supabase/cancelamento-klingo-pedido.sql`, 'utf8');
const reversao = readFileSync(`${REPO}/supabase/cancelamento-klingo-pedido-rollback.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await db.exec(`insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('a_confirmar', 'A confirmar', 0, 'agendamento', 'klingo'), ('confirmado', 'Confirmado', 1, 'agendamento', 'klingo'), ('chegou', 'Chegou', 2, 'depois', 'klingo'), ('em_atendimento', 'Em atendimento', 3, 'depois', 'klingo'), ('finalizado', 'Finalizado', 4, 'depois', 'klingo'), ('cancelado', 'Cancelado', 90, 'excecao', 'klingo'), ('remarcado', 'Remarcado', 91, 'excecao', 'klingo'), ('faltou', 'Faltou', 92, 'excecao', 'klingo'), ('agendado', 'Agendado', 5, 'agendamento', 'klingo') on conflict do nothing`);

const hoje = (await q(`select (now() at time zone 'America/Sao_Paulo')::date::text d`))[0].d;
const ontem = (await q(`select ((now() at time zone 'America/Sao_Paulo')::date - 1)::text d`))[0].d;
const linha = (m, extra = {}) => ({ m, a: '', p: '9' + m, n: 'PACIENTE TESTE', f: '', x: 'RX POLEGAR', o: 'Particular', u: 'CLÍNICA DE SAÚDE E IMAGEM - CSI', e: `${ontem} 09:00:00`, d: `${hoje} 16:30:00`, s: 'Aberta', t: 'N', r: '', c: 'Confirmado', ...extra });
const lote = async (linhas) => (await q(`select public.jornada_klingo_lote($1::jsonb) r`, [JSON.stringify(linhas)]))[0].r;
let seq = 0;
// pedido do chat "agendado" (ou outro estado) com as marcações guardadas; alerta do painel já aceso
async function pedido(marcacoes, { status = 'agendado', alerta = 'Marcação sumiu do Klingo' } = {}) {
  seq++;
  const ct = (await q(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, ['Teste ' + seq, '7198' + String(2000000 + seq)]))[0].id;
  const conv = (await q(`insert into public.conversas (contato_id, nome_informado, status, ia_ativa, alerta_agenda) values ($1, $2, 'aguardando', false, $3) returning id`, [ct, 'Teste ' + seq, alerta]))[0].id;
  await q(`insert into public.conversa_segredo (conversa_id) values ($1) on conflict do nothing`, [conv]);
  await q(`insert into public.conversa_fluxo (conversa_id, passo, dados) values ($1, 'humano', '{}'::jsonb) on conflict (conversa_id) do update set passo = 'humano'`, [conv]);
  await q(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, status, klingo_marcacoes, conferencia_status) values ($1, 'exame', 'RX POLEGAR', $2, $3::text[], 'sumiu')`, [conv, status, marcacoes]);
  for (const v of marcacoes) await q(`insert into public.klingo_marcacao (conversa_id, voucher, procedimento, situacao) values ($1, $2, 'RX POLEGAR', 'ativa')`, [conv, v]);
  return conv;
}
const pre = async (conv) => (await q(`select status, conferencia_status from public.pre_agendamentos where conversa_id = $1`, [conv]))[0];
const sit = async (conv, v) => (await q(`select situacao from public.klingo_marcacao where conversa_id = $1 and voucher = $2`, [conv, v]))[0].situacao;
const alerta = async (conv) => (await q(`select alerta_agenda a from public.conversas where id = $1`, [conv]))[0].a;
const notas = async (conv) => (await q(`select coalesce(jsonb_array_length(dados -> 'notas'), 0)::int n from public.conversa_fluxo where conversa_id = $1`, [conv]))[0].n;
const aberto = async (conv) => (await q(`select count(*)::int n from public.v_agendamento_aberto where conversa_id = $1`, [conv]))[0].n;

// ---------------------------------------------------------------- ANTES (o retrato ainda é o de antes da correção)
await caso('o arquivo de reversão aplica sem erro (garante o estado anterior)', async () => { await db.exec(reversao); return { ok: true }; });
const antes = await pedido(['9501']);
await lote([linha('9501', { s: 'Cancelada', r: 'Teste' })]);
await caso('ANTES da correção: a marcação cancelada no Klingo deixa o pedido "agendado" e "Exame em aberto" no painel (o defeito)', async () => {
  const j = (await q(`select status from public.jornada_exame where marcacao_id = 'm9501'`))[0];
  return { ok: j.status === 'cancelado' && (await pre(antes)).status === 'agendado' && (await aberto(antes)) === 1, detalhe: JSON.stringify([j, await pre(antes)]) };
});

await caso('cancelamento-klingo-pedido.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

// ---------------------------------------------------------------- DEPOIS
await caso('DEPOIS: o próximo lote com a marcação cancelada fecha o pedido que já estava parado (cobre os já cancelados)', async () => {
  const r = await lote([linha('9501', { s: 'Cancelada', r: 'Teste' })]);
  const p = await pre(antes);
  return { ok: r.pedidos_cancelados === 1 && p.status === 'cancelado' && (await aberto(antes)) === 0, detalhe: JSON.stringify([r, p]) };
});
await caso('a marcação do Klingo guardada no chat vira "cancelada", o alerta "Marcação sumiu do Klingo" sai e fica 1 nota interna', async () => {
  return { ok: (await sit(antes, '9501')) === 'cancelada' && (await alerta(antes)) === null && (await notas(antes)) === 1 };
});
await caso('repetir o mesmo lote não faz nada de novo (nenhuma nota a mais, pedidos_cancelados = 0)', async () => {
  const r = await lote([linha('9501', { s: 'Cancelada', r: 'Teste' })]);
  return { ok: r.pedidos_cancelados === 0 && (await notas(antes)) === 1, detalhe: JSON.stringify(r) };
});
await caso('o lote devolve também os campos de sempre (lidas, puladas, cartoes_criados, alteradas)', async () => {
  const r = await lote([linha('9501', { s: 'Cancelada', r: 'Teste' })]);
  return { ok: r.lidas === 1 && r.puladas === 0 && 'cartoes_criados' in r && 'alteradas' in r, detalhe: JSON.stringify(r) };
});
await caso('marcação ativa (confirmada) não fecha o pedido', async () => {
  const c = await pedido(['9502'], { alerta: null });
  const r = await lote([linha('9502')]);
  return { ok: r.pedidos_cancelados === 0 && (await pre(c)).status === 'agendado' && (await aberto(c)) === 1, detalhe: JSON.stringify(r) };
});
await caso('marcação REMARCADA no Klingo (cancelada com motivo "remarcada") não fecha o pedido', async () => {
  const c = await pedido(['9503'], { alerta: null });
  const r = await lote([linha('9503', { s: 'Cancelada', r: 'Remarcada' })]);
  return { ok: r.pedidos_cancelados === 0 && (await pre(c)).status === 'agendado', detalhe: JSON.stringify(r) };
});
await caso('pedido com 2 marcações: com só 1 cancelada continua em aberto; quando as 2 cancelam, fecha', async () => {
  const c = await pedido(['9504', '9505'], { alerta: null });
  const r1 = await lote([linha('9504', { s: 'Cancelada', r: 'Teste' }), linha('9505')]);
  const meio = (await pre(c)).status;
  const r2 = await lote([linha('9504', { s: 'Cancelada', r: 'Teste' }), linha('9505', { s: 'Cancelada', r: 'Teste' })]);
  return { ok: r1.pedidos_cancelados === 0 && meio === 'agendado' && r2.pedidos_cancelados === 1 && (await pre(c)).status === 'cancelado', detalhe: JSON.stringify([r1, meio, r2]) };
});
await caso('pedido que não está "agendado" (pronto) não é tocado, mesmo com a marcação cancelada', async () => {
  const c = await pedido(['9506'], { status: 'pronto', alerta: null });
  const r = await lote([linha('9506', { s: 'Cancelada', r: 'Teste' })]);
  return { ok: r.pedidos_cancelados === 0 && (await pre(c)).status === 'pronto', detalhe: JSON.stringify(r) };
});
await caso('marcação cancelada de um paciente sem pedido no chat: lote segue normal, nada fechado', async () => {
  const r = await lote([linha('9599', { s: 'Cancelada', r: 'Teste' })]);
  return { ok: r.lidas === 1 && r.pedidos_cancelados === 0 };
});
await caso('permissão: só o service_role executa pedido_fechar_cancelado_klingo (anon e logado não)', async () => {
  await anonimo();
  let anon = false;
  try { await q(`select public.pedido_fechar_cancelado_klingo(array['9501'])`); anon = true; } catch { /* esperado: sem permissão */ }
  await db.exec('reset role');
  const g = await q(`select has_function_privilege('anon', 'public.pedido_fechar_cancelado_klingo(text[])', 'execute') a, has_function_privilege('authenticated', 'public.pedido_fechar_cancelado_klingo(text[])', 'execute') u, has_function_privilege('service_role', 'public.pedido_fechar_cancelado_klingo(text[])', 'execute') s`);
  return { ok: !anon && !g[0].a && !g[0].u && g[0].s, detalhe: JSON.stringify(g[0]) };
});

// ---------------------------------------------------------------- a tela do paciente não repete o exame
await caso('app_pedido_dados: o exame "pedido" do chat não aparece de novo ao lado da marcação cancelada do Klingo (filtro com pre_status cancelado)', async () => {
  const def = (await q(`select pg_get_functiondef('public.app_pedido_dados(uuid, uuid)'::regprocedure) d`))[0].d;
  return { ok: /pre_status in \('agendado', 'cancelado'\)/.test(def) };
});
await caso('o arquivo de reversão devolve as duas funções (lote sem pedidos_cancelados) e o sql aplica de novo', async () => {
  await db.exec(reversao);
  const r = await lote([linha('9501', { s: 'Cancelada', r: 'Teste' })]);
  const volta = !('pedidos_cancelados' in r);
  await db.exec(sql);
  const r2 = await lote([linha('9501', { s: 'Cancelada', r: 'Teste' })]);
  return { ok: volta && 'pedidos_cancelados' in r2, detalhe: JSON.stringify([r, r2]) };
});

const falhou = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhou} de ${resultados.length} passaram.`);
process.exit(falhou ? 1 : 0);
