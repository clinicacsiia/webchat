// FLUXOGRAMA: entrada (clone da produção com os textos ANTIGOS do chat + supabase/textos-acolhimento*.sql) -> validação (cada texto muda, os {marcadores} ficam,
//   texto editado pela equipe é preservado, rodar duas vezes não muda nada) -> saída (PASS/FAIL).
// Versão 1.0 — 13/11/2026 / Mudança: Implementação inicial. Dados: todos inventados aqui.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, REPO } from './banco-producao.mjs';
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const { db } = await criarBancoProducao();
const q = async (sql) => (await db.query(sql)).rows;
const antigos = {
  ola_proprio: 'Olá, {nome}! Vamos com calma, é só tocar nas opções.',
  ola_filho: 'Olá, {nome}! Vamos organizar o atendimento de {paciente}. É só tocar nas opções.',
  horario: 'Agora escolha o dia e o horário que preferir. É uma previsão: o atendente confirma.',
  confirmar: 'Confira se está tudo certo:\n{resumo}\n\nAo confirmar, você envia uma PREVISÃO de agendamento. Quem confirma data, horário e valor é um atendente (uma pessoa da equipe).',
  pronto_online: 'Pronto, {nome}! Recebemos tudo e montamos a PREVISÃO do seu agendamento. Atenção: ainda não está confirmado.',
  pronto_offline: 'Pronto, {nome}! Montamos a PREVISÃO do seu agendamento e ela já está com a equipe. Ainda não está confirmado.',
  preco_previsao: 'Previsão de valor ({plano}):\n{itens}\n{total}Atenção: é só uma previsão. O valor final e a forma de pagamento são confirmados pelo atendente.',
};
for (const [c, t] of Object.entries(antigos)) await db.query(`insert into public.fluxo_texto (chave, texto, descricao) values ($1, $2, 'teste') on conflict (chave) do update set texto = excluded.texto`, [c, t]);
await db.query(`insert into public.config (chave, valor) values ('previsao_texto', 'Os dias são uma PREVISÃO.'), ('previsao_decide_texto', 'Fique na LISTA DE PREVISÃO. É só uma PREVISÃO.'), ('previsao_final_texto', 'Você ficou na lista de previsão.')
  on conflict (chave) do update set valor = excluded.valor`);
await db.query(`insert into public.fluxo_texto (chave, texto, descricao) values ('ola_proprio_editado', 'Texto editado pela equipe, sem mudança.', 'teste')`);
await db.query(`insert into public.fluxo_texto (chave, texto, descricao) values ('horario_x', 'x', 'teste')`);
await db.query(`update public.fluxo_texto set texto = 'Olá, {nome}! Texto próprio da equipe para {paciente}.' where chave = 'ola_filho'`);
const A = readFileSync(`${REPO}/supabase/textos-acolhimento.sql`, 'utf8'), B = readFileSync(`${REPO}/supabase/textos-acolhimento-botao.sql`, 'utf8');
await db.exec(A); await db.exec(B);
const ft = Object.fromEntries((await q(`select chave, texto from public.fluxo_texto`)).map((r) => [r.chave, r.texto]));
const cfg = Object.fromEntries((await q(`select chave, valor from public.config where chave like 'previsao_%texto'`)).map((r) => [r.chave, r.valor]));
for (const c of Object.keys(antigos).filter((x) => x !== 'ola_filho')) registrar(`texto ${c} mudou`, ft[c] !== antigos[c]);
registrar('ola_filho editado pela equipe NÃO foi sobrescrito', ft.ola_filho === 'Olá, {nome}! Texto próprio da equipe para {paciente}.');
const marc = (t) => [...new Set(t.match(/\{[a-z_]+\}/g) || [])].sort().join(',');
for (const c of Object.keys(antigos).filter((x) => x !== 'ola_filho')) registrar(`marcadores de ${c} preservados`, marc(ft[c]) === marc(antigos[c]), `${marc(antigos[c])} -> ${marc(ft[c])}`);
registrar('nenhum texto novo do paciente tem "previsão"', ![...Object.keys(antigos).filter((x) => x !== 'ola_filho').map((c) => ft[c]), ...Object.values(cfg)].some((t) => /previs[ãa]o/i.test(t)));
registrar('config de previsão trocada', Object.values(cfg).every((t) => !/previs[ãa]o/i.test(t)), JSON.stringify(cfg).slice(0, 80));
registrar('texto editado pela equipe foi preservado', ft.ola_proprio_editado === 'Texto editado pela equipe, sem mudança.' && ft.horario_x === 'x');
registrar('os textos novos dizem que não está confirmado', /ainda não está confirmado/i.test(ft.pronto_online) && /ainda não está confirmado/i.test(ft.pronto_offline) && /confirmar com você|confirma tudo|uma pessoa vai conferir/i.test(ft.confirmar + ft.horario));
const antes = JSON.stringify(ft); await db.exec(A); await db.exec(B);
const ft2 = Object.fromEntries((await q(`select chave, texto from public.fluxo_texto`)).map((r) => [r.chave, r.texto]));
registrar('rodar duas vezes não muda nada', JSON.stringify(ft2) === antes);
const f = (await q(`select pg_get_functiondef('public.previsao_pergunta(uuid,text)'::regprocedure) d`))[0].d;
registrar('botão da lista de espera trocado e valor "lista" mantido', /lista de espera/.test(f) && !/lista de previsão/.test(f) && /'valor', 'lista'/.test(f));
const ok = resultados.every(Boolean); console.log(`\n${resultados.filter(Boolean).length} de ${resultados.length} verificações passaram.`); await db.close?.(); process.exit(ok ? 0 : 1);
