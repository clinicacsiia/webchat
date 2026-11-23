// FLUXOGRAMA: entrada (clone da produção + previsao-marcacao-parte1..5 + supabase/previsao-reabre-conversa.sql; paciente e conversa INVENTADOS)
//   -> validação (reproduz o defeito de 23/11/2026 com as funções da produção: o pedido cai numa conversa ENCERRADA e ela continua encerrada)
//   -> lógica (depois da correção pedido, resposta e mensagem reabrem a conversa em "aguardando", sem robô e com o resumo; o paciente vê só a conversa atual e o aviso final volta)
//   -> saída (PASS/FAIL por caso) | ROLLBACK: supabase/previsao-reabre-conversa-rollback.sql
// Versão 1.0 — 23/11/2026 / Mudança: primeira versão. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo } = ajudantes(db);
registrar('o retrato da produção monta inteiro', falhas.length === 0, `${falhas.length} falhas`);

const partes = ['parte1-tabelas', 'parte2-paciente', 'parte3-painel', 'parte4-carga', 'parte5-escolha'].map((n) => readFileSync(`${REPO}/supabase/previsao-marcacao-${n}.sql`, 'utf8'));
for (const s of partes) await db.exec(s);
await db.exec(`insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('previsao_marcacao_modo', 'sim') on conflict (chave) do update set valor = excluded.valor`);
const chamar = async (fn, args = []) => {
  await anonimo();
  try { return (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args))[0].r; }
  catch (e) { return { erro: String(e.message) }; } finally { await db.exec('reset role'); }
};
const conv = (cod) => um(`select c.id, c.status, c.agente_id, c.ia_ativa, c.triagem_resumo, c.cliente_aguarda_desde from public.conversas c join public.pmarc_pessoa p on p.conversa_id = c.id where p.codigo = $1`, [cod]);
const textos = async (cod) => ((await chamar('pmarc_mensagens', [cod, 0])).mensagens || []).map((m) => m.texto);
const encerrar = async (cod) => {   // como a equipe: despedida da marca e conversa encerrada
  const c = await conv(cod);
  await db.exec(`insert into public.mensagens (conversa_id, autor, texto) values ('${c.id}', 'agente', 'O Meu Tesouro está sempre por perto (despedida de teste)')`);
  await db.exec(`update public.conversas set status = 'encerrada' where id = '${c.id}'`);
};

const novo = async (nome, cel) => (await chamar('pmarc_novo', [nome, cel, '1990-05-17', null])).codigo;
const A = await novo('ANA TESTE', '71988880001');
await chamar('pmarc_pedido', [A, JSON.stringify({ procedimento_texto: 'exame de teste um' })]);
await encerrar(A);

await caso('ANTES (função da produção): o pedido novo cai na conversa encerrada e ela CONTINUA encerrada; o paciente vê a conversa velha', async () => {
  const r = await chamar('pmarc_pedido', [A, JSON.stringify({ procedimento_texto: 'exame de teste dois' })]);
  const c = await conv(A); const t = await textos(A);
  return { ok: r.ok === true && c.status === 'encerrada' && t.some((x) => x.includes('despedida de teste')), detalhe: `${c.status}, ${t.length} mensagens` };
});

const sql = readFileSync(`${REPO}/supabase/previsao-reabre-conversa.sql`, 'utf8');
await caso('a migração aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

const B = await novo('BETO TESTE', '71988880002');
await chamar('pmarc_pedido', [B, JSON.stringify({ procedimento_texto: 'exame de teste um' })]);
await encerrar(B);
await caso('DEPOIS: pedido numa conversa encerrada a reabre em "aguardando", sem robô, sem atendente, com o resumo e na fila (cliente aguarda)', async () => {
  const r = await chamar('pmarc_pedido', [B, JSON.stringify({ procedimento_texto: 'exame de teste dois' })]);
  const c = await conv(B);
  return { ok: r.ok === true && c.status === 'aguardando' && c.agente_id === null && c.ia_ativa === false && /PREVIS/.test(c.triagem_resumo || '') && c.cliente_aguarda_desde !== null, detalhe: JSON.stringify({ ...c, triagem_resumo: (c.triagem_resumo || '').slice(0, 20) }) };
});
await caso('o paciente vê só a conversa atual: o pedido novo e o aviso final de novo, SEM a despedida antiga', async () => {
  const t = await textos(B);
  return { ok: t.length === 2 && t[0].startsWith('Pedido de previsão: exame de teste dois') && !t.some((x) => x.includes('despedida de teste')), detalhe: `${t.length} mensagens` };
});
await caso('a equipe continua vendo o histórico inteiro (nada foi apagado)', async () => {
  const n = (await um(`select count(*)::int n from public.mensagens m join public.pmarc_pessoa p on p.conversa_id = m.conversa_id where p.codigo = $1`, [B])).n;
  return { ok: n >= 5, detalhe: `${n} mensagens` };
});
await caso('conversa que NÃO está encerrada não muda de ponto de partida nem repete o aviso final', async () => {
  await chamar('pmarc_pedido', [B, JSON.stringify({ procedimento_texto: 'exame de teste tres' })]);
  const t = await textos(B); const c = await conv(B);
  return { ok: t.length === 3 && c.status === 'aguardando', detalhe: `${t.length} mensagens, ${c.status}` };
});

const C = await novo('CELIA TESTE', '71988880003');
await chamar('pmarc_pedido', [C, JSON.stringify({ procedimento_texto: 'exame de teste um' })]);
await encerrar(C);
await caso('escrever uma mensagem (pmarc_enviar) numa conversa encerrada também reabre e esconde a antiga', async () => {
  const r = await chamar('pmarc_enviar', [C, 'oi, tudo bem?']);
  const c = await conv(C); const t = await textos(C);
  return { ok: r.ok === true && c.status === 'aguardando' && c.ia_ativa === false && t[0] === 'oi, tudo bem?' && !t.some((x) => x.includes('despedida de teste')), detalhe: `${c.status}, ${t.length} mensagens` };
});

const D = await novo('DORA TESTE', '71988880004');
await chamar('pmarc_pedido', [D, JSON.stringify({ procedimento_texto: 'exame de teste um' })]);
await encerrar(D);
await caso('responder "não sei" (pmarc_responder) numa conversa encerrada também reabre', async () => {
  const r = await chamar('pmarc_responder', [D, JSON.stringify({ resposta: 'nao_sei' })]);
  const c = await conv(D); const t = await textos(D);
  return { ok: r.ok === true && c.status === 'aguardando' && !t.some((x) => x.includes('despedida de teste')), detalhe: `${c.status}, ${t.length} mensagens` };
});
await caso('a função nova é só do service_role; as 4 públicas continuam executáveis por anon', async () => {
  const r = await um(`select has_function_privilege('anon','public.pmarc_conversa_reabrir(uuid, uuid)','execute') a, has_function_privilege('authenticated','public.pmarc_conversa_reabrir(uuid, uuid)','execute') u, has_function_privilege('service_role','public.pmarc_conversa_reabrir(uuid, uuid)','execute') s,
    has_function_privilege('anon','public.pmarc_pedido(text, jsonb)','execute') p, has_function_privilege('anon','public.pmarc_enviar(text, text)','execute') e, has_function_privilege('anon','public.pmarc_responder(text, jsonb)','execute') r, has_function_privilege('anon','public.pmarc_mensagens(text, bigint)','execute') m`);
  return { ok: !r.a && !r.u && r.s && r.p && r.e && r.r && r.m, detalhe: JSON.stringify(r) };
});

const ruins = resultados.filter((x) => !x).length;
console.log(ruins ? `\n${ruins} FALHA(S)` : `\nTudo certo: ${resultados.length} casos`);
process.exit(ruins ? 1 : 0);
