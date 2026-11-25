// FLUXOGRAMA: entrada (clone da produção + supabase/previsao-conversa-sem-conta-da-atendente.sql; atendente com conta de paciente, paciente e pessoas da Previsão INVENTADOS)
//   -> validação (reproduz o defeito de 19/11/2026 com a função da produção: a conversa aberta pela atendente cai na conta de paciente dela)
//   -> lógica (depois da correção a conversa da atendente não tem conta; a do paciente logado continua com a conta dele; o caso antigo é solto e some do app da atendente)
//   -> saída (PASS/FAIL por caso) | ROLLBACK: cabeçalho de supabase/previsao-conversa-sem-conta-da-atendente.sql
// Versão 1.0 — 19/11/2026 / Mudança: primeira versão. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como } = ajudantes(db);
registrar('o retrato da produção monta inteiro', falhas.length === 0, `${falhas.length} falhas`);

const ATE = '00000000-0000-4000-8000-0000000000a2', PAC = '00000000-0000-4000-8000-0000000000b1';
await db.exec(`
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo') on conflict (chave) do update set valor = excluded.valor;
  insert into auth.users (id, email) values ('${ATE}', 'ate@x.invalid'), ('${PAC}', 'pac@x.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ATE}', 'Ate Teste', 'ate@x.invalid', 'atendente', true);
  insert into public.contas_paciente (id, email) values ('${ATE}', 'ate@x.invalid'), ('${PAC}', 'pac@x.invalid') on conflict (id) do nothing;
`);
await db.exec(`insert into public.config (chave, valor) values ('previsao_marcacao_modo', 'sim') on conflict (chave) do update set valor = 'sim'`);
const pessoa = async (chave, nome, cel) => {
  await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`);
  await q(`select public.pmarc_lote($1::jsonb)`, [JSON.stringify([{ p: chave, n: nome, c: cel }])]);
  return (await um(`select id from public.pmarc_pessoa where chave = $1`, [chave])).id;
};
const conta = async (conv) => (await um(`select conta_id from public.conversas where id = $1`, [conv])).conta_id;

let antigaConv, antigaApp;
// O retrato da produção JÁ traz a correção (aplicada e conferida), então o defeito antigo não se reproduz mais: a conversa aberta pela atendente nasce SEM conta de paciente.
// A segunda parte do arquivo prova que aplicar a migração de novo é seguro e que ela ainda limpa conversas antigas gravadas com o defeito.
await caso('RETRATO DA PRODUÇÃO: a conversa aberta pela atendente nasce sem conta de paciente (a correção já está no ar)', async () => {
  const id = await pessoa('9101', 'PESSOA UM TESTE', '71933330001');
  await como(ATE);
  const conv = (await q(`select public.painel_pmarc_conversa($1) v`, [id]))[0].v;
  await db.exec('reset role');
  antigaConv = conv;
  return { ok: (await conta(conv)) === null, detalhe: String(await conta(conv)) };
});

// o estado de produção: o acesso rápido da atendente já importou a conversa
await db.exec(`insert into public.app_paciente (id, telefone, nome, nascimento, pin_hash, email, conta_antiga_id) values ('00000000-0000-4000-8000-0000000000c1', '71988880001', 'Ate Teste', '1990-01-01', 'x', 'ate@x.invalid', '${ATE}')`);
antigaApp = '00000000-0000-4000-8000-0000000000c1';
await db.query(`insert into public.app_conversa (paciente_id, conversa_id, pessoa_nome, eu) values ($1, $2, 'Ate Teste', true)`, [antigaApp, antigaConv]);

const sql = readFileSync(`${REPO}/supabase/previsao-conversa-sem-conta-da-atendente.sql`, 'utf8').replaceAll('03da0299-ae30-4835-b47b-bb5fdecb9418', antigaConv).replaceAll('249b79d2-1760-468b-b4d3-e368c32e6004', antigaApp);
await caso('a migração aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

await caso('o caso antigo: a conversa sai da conta da atendente e some do app dela (as mensagens e a conversa continuam)', async () => {
  const n = (await um(`select count(*)::int n from public.app_conversa where conversa_id = $1`, [antigaConv])).n;
  const existe = (await um(`select count(*)::int n from public.conversas where id = $1`, [antigaConv])).n;
  return { ok: (await conta(antigaConv)) === null && n === 0 && existe === 1, detalhe: `${n} vínculos, conversa ${existe}` };
});
await caso('DEPOIS: a conversa nova aberta pela atendente não fica na conta de paciente dela, e segue com ela, em atendimento e sem robô', async () => {
  const id = await pessoa('9102', 'PESSOA DOIS TESTE', '71933330002');
  await como(ATE);
  const conv = (await q(`select public.painel_pmarc_conversa($1) v`, [id]))[0].v;
  await db.exec('reset role');
  const c = await um(`select conta_id, status, agente_id, ia_ativa from public.conversas where id = $1`, [conv]);
  return { ok: c.conta_id === null && c.status === 'em_atendimento' && c.agente_id === ATE && c.ia_ativa === false, detalhe: JSON.stringify(c) };
});
await caso('o paciente logado que abre a conversa pela própria página continua com ela na conta dele (nada mudou)', async () => {
  const id = await pessoa('9103', 'PESSOA TRES TESTE', '71933330003');
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: PAC, role: 'authenticated' })]);
  const conv = (await q(`select public.pmarc_conversa_garantir($1) v`, [id]))[0].v;   // sem atendente (p_por vazio), como a página pública
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  const c = await um(`select conta_id, status, agente_id from public.conversas where id = $1`, [conv]);
  return { ok: c.conta_id === PAC && c.agente_id === null, detalhe: JSON.stringify(c) };
});
await caso('a atendente pode usar o chat como paciente: a conversa que ela abre pelo chat (gatilho) continua na conta dela', async () => {
  await db.exec('reset role');
  await db.query(`insert into public.contatos (nome, telefone) values ('Ate Paciente Teste', '71977770001') on conflict do nothing`);
  const ct = (await um(`select id from public.contatos where telefone = '71977770001'`)).id;
  await como(ATE); await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: ATE, role: 'authenticated' })]);
  const c = (await q(`insert into public.conversas (contato_id) values ($1) returning conta_id`, [ct]))[0];
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  return { ok: c.conta_id === ATE, detalhe: String(c.conta_id) };
});
await caso('a função continua só do service_role (anon e logado não executam)', async () => {
  const r = await um(`select has_function_privilege('anon', 'public.pmarc_conversa_garantir(uuid, uuid)', 'execute') a, has_function_privilege('authenticated', 'public.pmarc_conversa_garantir(uuid, uuid)', 'execute') u, has_function_privilege('service_role', 'public.pmarc_conversa_garantir(uuid, uuid)', 'execute') s`);
  return { ok: r.a === false && r.u === false && r.s === true, detalhe: JSON.stringify(r) };
});

const ruins = resultados.filter((x) => !x).length;
console.log(ruins ? `\n${ruins} FALHA(S)` : `\nTudo certo: ${resultados.length} casos`);
process.exit(ruins ? 1 : 0);
