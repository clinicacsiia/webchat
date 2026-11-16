// FLUXOGRAMA: entrada (clone da produção + supabase/marcacao-automatica-por-unidade-parte1..4.sql) -> chaves marcacao_auto_<unidade> criadas ligadas -> unidade_marca_auto (liga/desliga por unidade do Klingo) -> aviso com as unidades ligadas -> as 3 funções do paciente carregam a trava
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (bloquear a marcação automática por unidade)
// Dados: nenhum dado real; só nomes de unidade e chaves de configuração.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um } = ajudantes(db);
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));

await q(`insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao, ordem) values
  ('desenvoar', 'DESENVOAR', 'Desenvoar', 'x', 'pediatria', 'x', 1),
  ('csi', 'CLÍNICA DE SAÚDE E IMAGEM - CSI', 'CSI', 'x', 'exame_consulta', 'x', 2),
  ('rmtc', 'CLÍNICA DE SAÚDE E IMAGEM - RM/TC', 'CSI RM/TC', 'x', 'exame_consulta', 'x', 3) on conflict do nothing`);
for (let i = 1; i <= 4; i++) {
  const sql = readFileSync(`${REPO}/supabase/marcacao-automatica-por-unidade-parte${i}.sql`, 'utf8');
  await caso(`parte ${i} aplica duas vezes sem erro (idempotente)`, async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
}
const U = { d: 'DESENVOAR', c: 'CLÍNICA DE SAÚDE E IMAGEM - CSI', r: 'CLÍNICA DE SAÚDE E IMAGEM - RM/TC' };
const marca = async (n) => (await um(`select public.unidade_marca_auto('${n}') as v`)).v;
await caso('as chaves nascem ligadas, uma por unidade', async () => {
  const r = await q(`select chave, valor from public.config where chave like 'marcacao\\_auto\\_%' order by 1`);
  return { ok: r.length === (await q('select 1 from public.unidade_config')).length && r.every((x) => x.valor === 'sim'), detalhe: JSON.stringify(r) };
});
await caso('tudo ligado: todas as unidades podem marcar sozinhas', async () => ({ ok: (await marca(U.d)) && (await marca(U.c)) && (await marca(U.r)) }));
await q(`update public.config set valor = 'nao' where chave in ('marcacao_auto_csi', 'marcacao_auto_rmtc')`);
await caso('CSI e RM/TC desligadas: só a Desenvoar marca', async () => ({ ok: (await marca(U.d)) && !(await marca(U.c)) && !(await marca(U.r)) }));
await caso('unidade desconhecida ou vazia nunca é travada', async () => ({ ok: (await marca('Outro lugar')) && (await um(`select public.unidade_marca_auto(null) as v`)).v }));
await caso('o aviso cita só a Desenvoar', async () => {
  const t = (await um(`select public.unidade_aviso_bloqueio() as v`)).v;
  return { ok: /só para Desenvoar\./.test(t) && !/CSI/.test(t), detalhe: t };
});
await q(`update public.config set valor = 'sim' where chave = 'marcacao_auto_csi'`);
await caso('religar a CSI: o aviso passa a citar as duas', async () => {
  const t = (await um(`select public.unidade_aviso_bloqueio() as v`)).v;
  return { ok: /Desenvoar e CSI\./.test(t), detalhe: t };
});
for (const f of ['chat_horarios', 'chat_horario_escolher', 'klingo_pode_marcar']) {
  await caso(`${f} carrega a trava por unidade`, async () => ({ ok: (await um(`select pg_get_functiondef('public.${f}'::regproc) like '%unidade_marca_auto%' as v`)).v }));
}
const falhou = resultados.filter((x) => !x).length;
console.log(falhou ? `\n${falhou} FALHA(S)` : `\nTodos os ${resultados.length} testes passaram.`);
await db.close?.();
process.exit(falhou ? 1 : 0);
