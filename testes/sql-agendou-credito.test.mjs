// FLUXOGRAMA: entrada (clone da produção + a mudança supabase/indicadores-agendou-credito.sql; pedidos que viram "agendado" à mão e pelo sistema) -> validação (primeiro mostra o defeito com o código de ANTES: o agendamento do sistema não conta para ninguém) -> lógica (crédito: quem marcou à mão > dono da conversa > quem mais escreveu > ninguém) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 12/11/2026 / Mudança: Implementação inicial (pedido do dono em 12/11/2026)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + String(e.message).split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const { db, falhas } = await criarBancoProducao();
const { um, como } = ajudantes(db);

const ADM = '00000000-0000-4000-8000-0000000000a1', ANA = '00000000-0000-4000-8000-0000000000a2', BIA = '00000000-0000-4000-8000-0000000000a3';
await db.exec(`
  insert into auth.users (id, email) values ('${ADM}', 'adm@exemplo.invalid'), ('${ANA}', 'ana@exemplo.invalid'), ('${BIA}', 'bia@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Admin Teste', 'adm@exemplo.invalid', 'admin', true), ('${ANA}', 'Ana Teste', 'ana@exemplo.invalid', 'atendente', true), ('${BIA}', 'Bia Teste', 'bia@exemplo.invalid', 'atendente', true);
`);
let seq = 0;
// Cria conversa + pedido "pronto". dono = agente_id da conversa; msgs = [[agente, quantidade]].
const pedido = async ({ dono = null, msgs = [] } = {}) => {
  seq++;
  const ct = (await um(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, ['Paciente Teste ' + seq, '7198' + (2000000 + seq)])).id;
  const conv = (await um(`insert into public.conversas (contato_id, nome_informado, status, agente_id, ia_ativa) values ($1, $2, 'em_atendimento', $3, false) returning id`, [ct, 'Paciente Teste ' + seq, dono])).id;
  await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, status, etapa) values ($1, 'exame', 'RESSONANCIA DO JOELHO', 'pronto', 'pronto')`, [conv]);
  for (const [ag, n] of msgs) for (let i = 0; i < n; i++) await db.query(`insert into public.mensagens (conversa_id, autor, texto, agente_id) values ($1, 'agente', 'oi', $2)`, [conv, ag]);
  return conv;
};
const marcar = async (conv, quem) => {   // quem = uuid (atendente marcando no painel) ou null (o sistema: conferência/reconhecimento do Klingo)
  await db.exec(`reset role;`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [quem ? JSON.stringify({ sub: quem, role: 'authenticated' }) : '']);
  await db.query(`update public.pre_agendamentos set status = 'agendado', agendado_auto_em = case when $2::uuid is null then now() end where conversa_id = $1`, [conv, quem]);
  await db.query(`select set_config('request.jwt.claims', '', false)`);
};
const c1 = await pedido({ dono: ANA });                           // o sistema confirma; dono = Ana
const c2 = await pedido({ msgs: [[BIA, 2], [ANA, 1]] });          // o sistema confirma; sem dono; Bia escreveu mais
const c3 = await pedido();                                        // o sistema confirma; ninguém atendeu
const c4 = await pedido({ dono: ANA });                           // Bia marca à mão, mesmo sendo conversa da Ana
await marcar(c1, null); await marcar(c2, null); await marcar(c3, null); await marcar(c4, BIA);
const ler = async (fn, args = '') => { await como(ADM); try { return (await um(`select public.${fn}(${args}) as r`)).r; } finally { await como(null); } };
const por = (r, nome) => (r.pessoas || []).find((p) => p.nome === nome) || {};

// O retrato já traz as funções corrigidas: para mostrar o defeito, volta primeiro para as de antes (guardadas em testes/antes-agendou-credito/).
for (const n of ['painel_indicadores_atendentes', 'painel_indicadores_equipe']) await db.exec(readFileSync(`${REPO}/testes/antes-agendou-credito/${n}.sql`, 'utf8'));
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));

await caso('DEFEITO (função de antes): o agendamento confirmado pelo sistema não conta para ninguém; só o marcado à mão', async () => {
  const r = await ler('painel_indicadores_atendentes');
  return { ok: por(r, 'Ana Teste').agendados === 0 && por(r, 'Bia Teste').agendados === 1, detalhe: `Ana=${por(r, 'Ana Teste').agendados} Bia=${por(r, 'Bia Teste').agendados}` };
});

await db.exec(readFileSync(`${REPO}/supabase/indicadores-agendou-credito.sql`, 'utf8'));

await caso('CORRIGIDO: o do sistema vai para o dono da conversa (Ana) ou, sem dono, para quem mais escreveu (Bia); o de ninguém não conta', async () => {
  const r = await ler('painel_indicadores_atendentes');
  const ana = por(r, 'Ana Teste'), bia = por(r, 'Bia Teste');
  return { ok: ana.agendados === 1 && ana.agendados_automaticos === 1 && bia.agendados === 2 && bia.agendados_automaticos === 1, detalhe: `Ana=${ana.agendados}/${ana.agendados_automaticos} Bia=${bia.agendados}/${bia.agendados_automaticos}` };
});

await caso('quem marcou à mão fica com o crédito, mesmo que a conversa seja de outra pessoa', async () => {
  const r = await ler('painel_indicadores_atendentes');
  const total = (r.pessoas || []).reduce((t, p) => t + p.agendados, 0);
  return { ok: total === 3, detalhe: `total creditado = ${total} (de 4 agendados; 1 sem ninguém)` };
});

await caso('a aba Equipe/Estrutura (painel_indicadores_equipe) usa o mesmo crédito', async () => {
  const r = await ler('painel_indicadores_equipe');
  return { ok: por(r, 'Ana Teste').agendados === 1 && por(r, 'Bia Teste').agendados === 2 && r.agendados_pelo_sistema === 3, detalhe: `Ana=${por(r, 'Ana Teste').agendados} Bia=${por(r, 'Bia Teste').agendados} sistema=${r.agendados_pelo_sistema}` };
});

await caso('período sem agendamento continua zerado e sem erro', async () => {
  const r = await ler('painel_indicadores_atendentes', `current_date - 30, current_date - 20`);
  return { ok: (r.pessoas || []).every((p) => p.agendados === 0), detalhe: JSON.stringify((r.pessoas || []).map((p) => p.agendados)) };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
