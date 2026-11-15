// FLUXOGRAMA: entrada (o retrato da produção + supabase/checkin-klingo.sql; linhas do lote com a chave 'k' = check-in do Klingo; conversas abertas pelo motor REAL do chat; exames da Jornada inventados) -> validação (check-in só vale no formato AAAA-MM-DD…; chave 'k' ausente não mexe; inválido é ignorado) -> lógica (jornada_exame.checkin_em; a etapa Chegada (ok = 4) aparece com check-in NO DIA DO EXAME; o número da marcação (m123 -> 123) e a hora da chegada vão para a tela) -> saída (PASS/FAIL por caso; sai com erro se algum falhar)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (check-in do Klingo na Jornada e na tela Minha vez)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, anonimo } = ajudantes(db);
const sql = readFileSync(`${REPO}/supabase/checkin-klingo.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('checkin-klingo.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.exec(`insert into public.config (chave, valor) values ('app_acesso_modo', 'sim') on conflict (chave) do update set valor = 'sim'`);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste'), ('klingo_interno_segredo', 'segredo-de-teste') on conflict (name) do nothing`);
await db.exec(`insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('a_confirmar', 'A confirmar', 0, 'agendamento', 'klingo'), ('confirmado', 'Confirmado', 1, 'agendamento', 'klingo'), ('chegou', 'Chegou', 2, 'depois', 'klingo'), ('em_atendimento', 'Em atendimento', 3, 'depois', 'klingo'), ('finalizado', 'Finalizado', 4, 'depois', 'klingo'), ('cancelado', 'Cancelado', 90, 'excecao', 'klingo'), ('remarcado', 'Remarcado', 91, 'excecao', 'klingo'), ('faltou', 'Faltou', 92, 'excecao', 'klingo'), ('agendado', 'Agendado', 5, 'agendamento', 'klingo') on conflict do nothing`);

const hoje = (await q(`select (now() at time zone 'America/Sao_Paulo')::date::text d`))[0].d;
const ontem = (await q(`select ((now() at time zone 'America/Sao_Paulo')::date - 1)::text d`))[0].d;
const exameDe = async (m) => (await q(`select * from public.jornada_exame where marcacao_id = $1`, [m]))[0];
const linha = (m, extra = {}) => ({ m: m.replace(/^m/, ''), a: '', p: '9001', n: 'PACIENTE TESTE', f: '', x: 'RM JOELHO', o: 'Particular', u: 'CLÍNICA DE SAÚDE E IMAGEM - CSI', e: `${ontem} 09:00:00`, d: `${hoje} 08:00:00`, s: 'Aberta', t: 'N', r: '', c: 'Confirmado', ...extra });
const lote = async (linhas) => (await q(`select public.jornada_klingo_lote($1::jsonb) r`, [JSON.stringify(linhas)]))[0].r;
const hora = async (m) => (await q(`select to_char(checkin_em at time zone 'America/Sao_Paulo', 'YYYY-MM-DD HH24:MI') h from public.jornada_exame where marcacao_id = $1`, [m]))[0].h;

// ---------------------------------------------------------------- o lote
await caso('lote: o check-in (chave k) fica gravado na hora de Brasília', async () => {
  await lote([linha('m9001', { k: `${hoje} 07:50:00` })]);
  return { ok: (await hora('m9001')) === `${hoje} 07:50` , detalhe: await hora('m9001') };
});
await caso('lote: linha SEM a chave k (leitura antiga) não apaga o check-in', async () => {
  await lote([linha('m9001')]);
  return { ok: (await hora('m9001')) === `${hoje} 07:50` };
});
await caso('lote: quando só o check-in muda (o resto igual), a linha é atualizada (alteradas = 1)', async () => {
  const r = await lote([linha('m9001', { k: `${hoje} 07:55:00` })]);
  return { ok: r.alteradas === 1 && (await hora('m9001')) === `${hoje} 07:55`, detalhe: JSON.stringify(r) };
});
await caso('lote: a mesma linha de novo não altera nada (alteradas = 0)', async () => {
  const r = await lote([linha('m9001', { k: `${hoje} 07:55:00` })]);
  return { ok: r.alteradas === 0 && r.lidas === 1, detalhe: JSON.stringify(r) };
});
await caso('lote: chave k vazia limpa o check-in (check-in desfeito no Klingo)', async () => {
  await lote([linha('m9001', { k: '' })]);
  return { ok: (await exameDe('m9001')).checkin_em === null };
});
await caso('lote: valor inválido em k é ignorado, sem erro e sem gravar', async () => {
  const r = await lote([linha('m9002', { k: 'não é data' }), linha('m9003', { k: '16/11/2026 07:50' })]);
  return { ok: r.lidas === 2 && (await exameDe('m9002')).checkin_em === null && (await exameDe('m9003')).checkin_em === null, detalhe: JSON.stringify(r) };
});
await caso('lote: o resto do que o lote já fazia continua igual (situação e atendimento)', async () => {
  await lote([linha('m9004', { a: '777', t: 'S', k: `${hoje} 07:40:00` })]);
  const e = await exameDe('m9004');
  return { ok: e.status === 'atendido' && e.atendimento_id === '777' && e.confirm_status === 'Confirmado', detalhe: JSON.stringify({ status: e.status, a: e.atendimento_id }) };
});

// ---------------------------------------------------------------- tela do acesso rápido (app_pedidos)
const rpc = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
const TEL = '71991230001';
const ana = await rpc('app_cadastrar', { p_telefone: TEL, p_nome: 'Ana Souza Teste', p_nascimento: '1988-04-12', p_pin: '1357', p_filhos: [], p_aparelho: 'teste' });
await q(`update public.conversas set criado_em = criado_em - interval '2 hours'`);
const ini = await rpc('chat_iniciar', { p_nome: 'Ana Souza Teste', p_telefone: TEL, p_email: 'ana@exemplo.invalid', p_aceite: true, p_paciente_tipo: 'proprio' });
await rpc('app_conversa_vincular', { p_token: ana.token, p_conversa: ini.conversa_id, p_conv_token: ini.token });
const card = (await q(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna, conversa_id) values ('9100', $1, 'Centro', 'agendado', $2) returning id`, [hoje, ini.conversa_id]))[0].id;
// m9101: check-in hoje | m9102: sem check-in | m9103: check-in de ontem (exame hoje) | m9104: atendido com check-in | m9105: exame de amanhã com check-in de hoje (inválido)
const mk = async (m, status, conf, paraSql, checkinSql) => q(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, status, confirm_status, unidade, atendimento_id, agendado_para, checkin_em) values ($1, $2, $3, $4, $5, 'Centro', null, ${paraSql}, ${checkinSql})`, [card, m, 'EXAME ' + m, status, conf]);
const agora8 = `(($1::date)::timestamp + interval '8 hours') at time zone 'America/Sao_Paulo'`;
await q(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, status, confirm_status, unidade, agendado_para, checkin_em) values
  ($1, 'm9101', 'EXAME 9101', 'confirmado', 'Confirmado', 'Centro', (($2::date)::timestamp + interval '8 hours') at time zone 'America/Sao_Paulo', (($2::date)::timestamp + interval '7 hours 50 minutes') at time zone 'America/Sao_Paulo'),
  ($1, 'm9102', 'EXAME 9102', 'confirmado', 'Confirmado', 'Centro', (($2::date)::timestamp + interval '9 hours') at time zone 'America/Sao_Paulo', null),
  ($1, 'm9103', 'EXAME 9103', 'confirmado', 'Confirmado', 'Centro', (($2::date)::timestamp + interval '10 hours') at time zone 'America/Sao_Paulo', (($3::date)::timestamp + interval '10 hours') at time zone 'America/Sao_Paulo'),
  ($1, 'ite:230', 'EXAME ITE', 'pedido', null, 'Centro', null, null),
  ($1, 'm9105', 'EXAME 9105', 'confirmado', 'Confirmado', 'Centro', (($2::date)::timestamp + interval '1 day 8 hours') at time zone 'America/Sao_Paulo', (($2::date)::timestamp + interval '7 hours') at time zone 'America/Sao_Paulo')`, [card, hoje, ontem]);
await q(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, status, confirm_status, unidade, atendimento_id, agendado_para, checkin_em)
  values ($1, 'm9104', 'EXAME 9104', 'atendido', 'Confirmado', 'Centro', '555', (($2::date)::timestamp + interval '11 hours') at time zone 'America/Sao_Paulo', (($2::date)::timestamp + interval '10 hours 45 minutes') at time zone 'America/Sao_Paulo')`, [card, hoje]);

const exames = async () => { const r = await rpc('app_pedidos', { p_token: ana.token, p_renova: true }); const lista = r.pedidos || r.lista || r.itens || []; if (!lista.length) console.log('   (app_pedidos devolveu:', JSON.stringify(r).slice(0, 200), ')'); const todos = lista.flatMap((p) => p.exames || []); return Object.fromEntries(todos.map((e) => [e.nome.replace('EXAME ', ''), e])); };
await caso('app_pedidos: exame com check-in de hoje vira Chegada (ok 4), com a hora e o número da marcação', async () => {
  const e = (await exames())['9101'];
  return { ok: e && e.ok === 4 && e.chegada === '07:50' && e.voucher === '9101', detalhe: JSON.stringify(e) };
});
await caso('app_pedidos: sem check-in continua como antes (confirmado = 3), com número e sem hora de chegada', async () => {
  const e = (await exames())['9102'];
  return { ok: e && e.ok === 3 && e.chegada === null && e.voucher === '9102', detalhe: JSON.stringify(e) };
});
await caso('app_pedidos: check-in de OUTRO dia não conta como chegada', async () => {
  const e = (await exames())['9103'];
  return { ok: e && e.ok === 3 && e.chegada === null, detalhe: JSON.stringify(e) };
});
await caso('app_pedidos: check-in de hoje num exame de amanhã não conta', async () => {
  const e = (await exames())['9105'];
  return { ok: e && e.ok === 3 && e.chegada === null, detalhe: JSON.stringify(e) };
});
await caso('app_pedidos: atendido continua ok 5 (a chegada não rebaixa) e mantém a hora do check-in', async () => {
  const e = (await exames())['9104'];
  return { ok: e && e.ok === 5 && e.chegada === '10:45' && e.voucher === '9104', detalhe: JSON.stringify(e) };
});
await caso('app_pedidos: pedido do chat (ite:…) não ganha número de marcação', async () => {
  const e = (await exames())['ITE'];
  return { ok: e && e.voucher === null && e.chegada === null, detalhe: JSON.stringify(e) };
});

// ---------------------------------------------------------------- tela da conta (paciente_jornada)
const uid = (await q(`insert into auth.users (id, email) values (gen_random_uuid(), 'conta@exemplo.invalid') returning id`))[0].id;
await q(`insert into public.contas_paciente (id, email, nome, telefone, identidade_conferida_em) values ($1, 'conta@exemplo.invalid', 'Conta Teste', '71991230009', null)`, [uid]);
await q(`update public.conversas set conta_id = $1 where id = $2`, [uid, ini.conversa_id]);
const jor = async () => {
  await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: uid, role: 'authenticated' })]); await db.exec('set role authenticated');
  try { return (await q('select public.paciente_jornada() r'))[0].r; } finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); }
};
await caso('paciente_jornada: Chegada pelo check-in do dia, número da marcação e hora; check-in de outro dia não conta', async () => {
  const r = await jor(); const por = Object.fromEntries(r.visitas.flatMap((v) => v.exames).map((e) => [e.nome.replace('EXAME ', ''), e]));
  return { ok: por['9101'].ok === 4 && por['9101'].chegada === '07:50' && por['9101'].voucher === '9101' && por['9103'].ok === 3 && por['9103'].chegada === null && por['9104'].ok === 5, detalhe: JSON.stringify([por['9101'], por['9103']]) };
});

const falhou = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhou} de ${resultados.length} passaram.`);
process.exit(falhou ? 1 : 0);
