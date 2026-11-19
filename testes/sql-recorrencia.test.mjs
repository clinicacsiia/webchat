// FLUXOGRAMA: entrada (o retrato da produção em supabase/producao/ montado num Postgres embutido + supabase/indicadores-recorrencia.sql + pessoas e contas inventadas aqui) -> validação (cada número do indicador de recorrência conferido à mão: primeira vez, recorrentes, cadastradas, acesso rápido) -> lógica (pessoa = conversas agrupadas; teste fora; filtro de unidade; permissões) -> saída (PASS/FAIL por caso).
// Versão 1.0 — 19/11/2026 / Mudança: Implementação inicial (indicador de recorrência).
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);

const ADMIN = '00000000-0000-4000-8000-0000000000a1', ATEND = '00000000-0000-4000-8000-0000000000a2', PACIENTE = '00000000-0000-4000-8000-0000000000b1';
await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}', 'admin@exemplo.invalid'), ('${ATEND}', 'atendente@exemplo.invalid'), ('${PACIENTE}', 'paciente@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADMIN}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true), ('${ATEND}', 'Atendente Teste', 'atendente@exemplo.invalid', 'atendente', true);
  insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao) values
    ('csi', 'csi', 'CSI', 'CSI', 'exame_consulta', 'x'), ('desenvoar', 'desenvoar', 'Desenvoar', 'Desenvoar', 'pediatria', 'x') on conflict (chave) do nothing;
`);

// Instala o arquivo novo, em duas partes, como será aplicado na produção.
const SQL = readFileSync(`${REPO}/supabase/indicadores-recorrencia.sql`, 'utf8');
await caso('o arquivo supabase/indicadores-recorrencia.sql instala sem erro', async () => {
  const { separarSql } = await import('./banco-producao.mjs');
  for (const cmd of separarSql(SQL)) await db.exec(cmd);
  return { ok: true };
});

// ---------------------------------------------------------------- dados inventados (datas relativas a hoje, no fuso de São Paulo)
const hoje = (await um(`select (now() at time zone 'America/Sao_Paulo')::date::text d`)).d;
const dia = (n) => `((('${hoje}'::date + (${n})) || ' 12:00:00-03')::timestamptz)`;   // meio-dia de SP, n dias a partir de hoje
let seq = 0;
const FONES = new Map();
const conversa = async ({ nome, quando, un = null, teste = false, grupo = null }) => {
  seq++;
  // a mesma pessoa volta com o MESMO telefone (um contato, várias conversas), como no chat de verdade
  if (!FONES.has(nome)) FONES.set(nome, '7198' + String(2000000 + seq));
  const fone = FONES.get(nome);
  const ct = (await um(`insert into public.contatos (nome, telefone, teste) values ($1, $2, $3) on conflict (telefone) do update set nome = excluded.nome returning id`, [nome, fone, teste])).id;
  const id = (await um(`insert into public.conversas (contato_id, nome_informado, status, ia_ativa, unidade_inicial, teste) values ($1, $2, 'encerrada', false, $3, $4) returning id`, [ct, nome, un, teste])).id;
  await db.exec(`update public.conversas set criado_em = ${dia(quando)} where id = '${id}'`);
  if (grupo) await db.query(`insert into public.conversa_grupo (conversa_id, grupo_id, sinais, origem) values ($1, $2, '{}', 'equipe') on conflict (conversa_id) do update set grupo_id = excluded.grupo_id`, [id, grupo]);
  return id;
};
// Período olhado: os 7 dias que terminam hoje = de -6 a 0.
const G_D = '00000000-0000-4000-8000-0000000000d4';
await conversa({ nome: 'Pessoa A Recorrente', quando: -20, un: 'csi' });
await conversa({ nome: 'Pessoa A Recorrente', quando: -2, un: 'csi' });
await conversa({ nome: 'Pessoa B Nova', quando: -3, un: 'desenvoar' });
await conversa({ nome: 'Pessoa C Nova Voltou', quando: -5, un: 'desenvoar' });
await conversa({ nome: 'Pessoa C Nova Voltou', quando: -1, un: 'desenvoar' });
await conversa({ nome: 'Pessoa D Duas Conversas', quando: -30, un: 'csi', grupo: G_D });
await conversa({ nome: 'Pessoa D Outro Nome', quando: -3, un: 'csi', grupo: G_D });
await conversa({ nome: 'Pessoa E Teste', quando: -2, un: 'csi', teste: true });
await conversa({ nome: 'Pessoa F Antiga', quando: -40, un: 'csi' });
// Conversas AGRUPADAS pelo gatilho de pessoa única (mesmo nome/telefone parecido) mudariam a conta: confere que as 3 pessoas A, B, C não foram juntadas sozinhas.
await db.exec(`
  insert into public.app_paciente (telefone, nome, nascimento, pin_hash, criado_em, ultimo_acesso_em) values
    ('71988880001', 'Conta X Antiga', '1980-01-01', 'x', ${dia(-10)}, ${dia(-2)}),
    ('71988880002', 'Conta Y So Hoje', '1981-01-01', 'x', ${dia(-2)}, ${dia(-2)}),
    ('71988880003', 'Conta Z Voltou', '1982-01-01', 'x', ${dia(-3)}, ${dia(-1)}),
    ('71988880004', 'Conta W Fora Do Periodo', '1983-01-01', 'x', ${dia(-40)}, ${dia(-35)});
`);

const painel = async (de, ate, un = null, teste = false) => (await um(`select public.painel_indicadores_recorrencia($1::date, $2::date, $3, $4) j`, [de, ate, un, teste])).j;
const p7 = async (un = null, teste = false) => painel(await d(-6), hoje, un, teste);
const d = async (n) => (await um(`select ('${hoje}'::date + ${n})::text d`)).d;

await como(ATEND);

await caso('pessoas cadastradas no chat: 5 (A, B, C, D agrupada e F; E fica fora por ser teste)', async () => {
  const j = await p7(); const c = j.atual.chat;
  return { ok: c.cadastradas === 5, detalhe: `cadastradas = ${c.cadastradas} (esperado 5: A, B, C, D, F)` };
});
await caso('quem usou o chat nos 7 dias: A, B, C, D = 4 pessoas (D tem duas conversas mas conta uma vez; F não voltou)', async () => {
  const c = (await p7()).atual.chat;
  return { ok: c.usaram === 4 && c.conversas_no_periodo === 5, detalhe: `usaram = ${c.usaram}, conversas no período = ${c.conversas_no_periodo} (esperado 4 e 5)` };
});
await caso('primeira vez = B e C (2); recorrentes = A e D (2); C já voltou dentro do período', async () => {
  const c = (await p7()).atual.chat;
  return { ok: c.primeira_vez === 2 && c.recorrentes === 2 && c.primeira_vez_voltaram === 1 && c.primeira_vez + c.recorrentes === c.usaram, detalhe: `primeira vez ${c.primeira_vez}, recorrentes ${c.recorrentes}, novas que voltaram ${c.primeira_vez_voltaram}` };
});
await caso('cadastradas antes do período = A, D e F (3); histórico: 3 pessoas com 1 conversa e 2 com 2', async () => {
  const c = (await p7()).atual.chat;
  return { ok: c.cadastradas_antes === 3 && c.historico_1 === 2 && c.historico_2 === 3 && c.historico_3mais === 0, detalhe: JSON.stringify([c.cadastradas_antes, c.historico_1, c.historico_2, c.historico_3mais]) };
});
await caso('conversa de teste fica fora por padrão e entra só quando pedido', async () => {
  const sem = (await p7()).atual.chat, com = (await p7(null, true)).atual.chat;
  return { ok: sem.cadastradas === 5 && com.cadastradas === 6 && com.primeira_vez === 3, detalhe: `sem teste ${sem.cadastradas} cadastradas; com teste ${com.cadastradas}, primeira vez ${com.primeira_vez}` };
});
await caso('filtro de unidade: desenvoar = B e C (2 de primeira vez, 0 recorrentes); csi = A e D recorrentes', async () => {
  const dv = (await p7('desenvoar')).atual.chat, cs = (await p7('csi')).atual.chat;
  return { ok: dv.usaram === 2 && dv.primeira_vez === 2 && dv.recorrentes === 0 && cs.usaram === 2 && cs.primeira_vez === 0 && cs.recorrentes === 2 && cs.cadastradas === 3,
    detalhe: `desenvoar ${dv.usaram}/${dv.primeira_vez}/${dv.recorrentes}; csi ${cs.usaram}/${cs.primeira_vez}/${cs.recorrentes}, cadastradas csi ${cs.cadastradas}` };
});
await caso('período anterior (os 7 dias antes): ninguém abriu conversa de -13 a -7; cadastradas até -7 = A, D, F', async () => {
  const j = await p7(); const b = j.anterior.chat;
  return { ok: b.usaram === 0 && b.cadastradas === 3 && j.anterior_periodo.ate === (await d(-7)), detalhe: `anterior usaram ${b.usaram}, cadastradas ${b.cadastradas}` };
});
await caso('por dia: -5 (C nova), -3 (B nova + D recorrente), -2 (A), -1 (C já falou antes); só o gráfico do período atual', async () => {
  const j = await p7(); const m = new Map(j.atual.por_dia.map((x) => [x.dia, x]));
  const x5 = m.get(await d(-5)), x3 = m.get(await d(-3)), x2 = m.get(await d(-2)), x1 = m.get(await d(-1));
  return { ok: j.atual.por_dia.length === 4 && x5.primeira_vez === 1 && x3.pessoas === 2 && x3.primeira_vez === 1 && x3.recorrentes === 1 && x2.recorrentes === 1 && x1.pessoas === 1 && x1.primeira_vez === 0 && j.anterior.por_dia.length === 0,
    detalhe: JSON.stringify(j.atual.por_dia.map((x) => [x.dia.slice(5), x.pessoas, x.primeira_vez, x.recorrentes])) };
});
await caso('acesso rápido: 4 contas no total, 2 novas no período, 3 usaram, 1 voltou (conta antiga), 3 já voltaram em outro dia (inclui a conta antiga fora do período), 1 só no dia do cadastro', async () => {
  const a = (await p7()).atual.acesso_rapido;
  return { ok: a.total === 4 && a.novas === 2 && a.usaram === 3 && a.voltaram === 1 && a.voltaram_outro_dia === 3 && a.so_no_dia_do_cadastro === 1, detalhe: JSON.stringify(a) };
});
await caso('acesso rápido não depende do filtro de unidade (é da clínica toda)', async () => {
  const a = (await p7('desenvoar')).atual.acesso_rapido;
  return { ok: a.total === 4 && a.novas === 2, detalhe: JSON.stringify(a) };
});
await caso('o resultado só tem números: nenhum nome de pessoa ou conta aparece', async () => {
  const txt = JSON.stringify(await p7(null, true));
  return { ok: !/Pessoa|Conta|7198|7198888/.test(txt), detalhe: txt.length + ' caracteres' };
});
await caso('período de um dia e datas fora do limite não quebram (hoje; futuro vira hoje; de maior que até é corrigido)', async () => {
  const a = await painel(hoje, hoje), b = await painel(await d(5), await d(9)), c = await painel(hoje, await d(-3));
  return { ok: a.periodo.de === hoje && b.periodo.ate === hoje && c.periodo.de <= c.periodo.ate, detalhe: JSON.stringify([a.periodo, b.periodo, c.periodo]) };
});

await como(ADMIN);
await caso('administrador também vê', async () => ({ ok: (await p7()).atual.chat.cadastradas === 5 }));
await como(PACIENTE);
await caso('paciente logado NÃO vê o indicador', async () => {
  let e = ''; try { await db.query(`select public.painel_indicadores_recorrencia(null, null, null, false)`); } catch (x) { e = x.message; }
  return { ok: /Somente administrador|permission denied/.test(e), detalhe: e.slice(0, 80) };
});
await anonimo();
await caso('visitante sem login NÃO chama a função do painel nem a interna', async () => {
  let e1 = '', e2 = '';
  try { await db.query(`select public.painel_indicadores_recorrencia(null, null, null, false)`); } catch (x) { e1 = x.message; }
  try { await db.query(`select public.ind_recorrencia_periodo(current_date, current_date, null, false, false)`); } catch (x) { e2 = x.message; }
  return { ok: /permission denied/.test(e1) && /permission denied/.test(e2), detalhe: `${e1.slice(0, 50)} | ${e2.slice(0, 50)}` };
});
await como(ATEND);
await caso('atendente logada NÃO chama a função interna direto', async () => {
  let e = ''; try { await db.query(`select public.ind_recorrencia_periodo(current_date, current_date, null, false, false)`); } catch (x) { e = x.message; }
  return { ok: /permission denied/.test(e), detalhe: e.slice(0, 80) };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram.${falhas.length ? ` (${falhas.length} comandos do retrato não entraram)` : ''}`);
process.exit(ok === resultados.length ? 0 : 1);
