// FLUXOGRAMA: entrada (clone da produção + supabase/indicadores-cinco-numeros.sql; pessoas, pedidos, marcações e mensagens INVENTADOS) -> validação (só admin/atendente leem; conversa de teste fica fora; período e filtro de tipo respeitados) -> lógica (confere os 5 números do topo da aba Indicadores: todos em PESSOAS pelo dia em que abriram o chat) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 18/11/2026 / Mudança: Implementação inicial.
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + String(e.message).split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const { db } = await criarBancoProducao();
const { um, como } = ajudantes(db);

const ADM = '00000000-0000-4000-8000-0000000000c1', ANA = '00000000-0000-4000-8000-0000000000c2';
await db.exec(`
  insert into auth.users (id, email) values ('${ADM}', 'adm@exemplo.invalid'), ('${ANA}', 'ana@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Admin Teste', 'adm@exemplo.invalid', 'admin', true), ('${ANA}', 'Ana Teste', 'ana@exemplo.invalid', 'atendente', true);
`);
await db.exec(readFileSync(`${REPO}/supabase/indicadores-cinco-numeros.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/indicadores-sem-unidade-filtro.sql`, 'utf8'));   // 23/11/2026: o filtro 'sem' passa a valer

await db.query(`insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('agendado', 'Agendado', 1, 'agendamento', 'klingo') on conflict (id) do nothing`);
const card = (await um(`insert into public.jornada_card (paciente_chave, data_ref, coluna) values ('teste-cinco', current_date, 'agendado') returning id`)).id;
let seq = 0;
// Uma pessoa = um contato + uma conversa (+ um pedido). tipo = do pedido; m = id da marcação no Klingo; je = status da marcação na Jornada; humano = um atendente escreveu; dias = quantos dias atrás abriu o chat.
const pessoa = async ({ tipo = 'consulta', m = null, origem = null, je = null, humano = false, teste = false, dias = 0, semPedido = false } = {}) => {
  seq++;
  const ct = (await um(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, ['Paciente Teste ' + seq, '7197' + (4000000 + seq)])).id;
  const conv = (await um(`insert into public.conversas (contato_id, nome_informado, status, ia_ativa, teste, criado_em) values ($1, $2, 'em_atendimento', false, $3, now() - ($4 || ' days')::interval) returning id`, [ct, 'Paciente Teste ' + seq, teste, String(dias)])).id;
  if (!semPedido) await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, status, etapa, klingo_marcacoes, agendado_origem) values ($1, $2, 'PROCEDIMENTO TESTE', $3, 'pronto', $4, $5)`, [conv, tipo, m ? 'agendado' : 'rascunho', m ? [m] : null, origem]);
  if (m && je) await db.query(`insert into public.jornada_exame (card_id, marcacao_id, status, procedimento, agendado_para) values ($1, $2, $3, 'PROCEDIMENTO TESTE', now())`, [card, 'm' + m, je]);
  if (humano) {
    await db.query(`insert into public.mensagens (conversa_id, autor, texto, agente_id) values ($1, 'agente', 'oi', $2)`, [conv, ANA]);
    await db.query(`update public.conversas set agente_id = $2 where id = $1`, [conv, ANA]);   // o gatilho do banco grava primeiro_humano_em
  }
  return conv;
};
await db.exec(`delete from public.mensagens; delete from public.pre_agendamentos; delete from public.conversas;`);
await pessoa({ tipo: 'consulta', humano: true });                                                  // A: só procurou, foi atendida
await pessoa({ tipo: 'exame', m: '8000001', origem: 'equipe', je: 'atendido', humano: true });    // B: exame marcado pela equipe, veio
await pessoa({ tipo: 'exame', m: '8000002', origem: 'chat_api', je: 'agendado' });                // C: exame marcado pelo robô, sem atendente nenhum
await pessoa({ tipo: 'exame', m: '8000003', origem: 'chat_api', je: 'faltou', humano: true });    // D: exame marcado pelo robô, houve atendente, faltou
await pessoa({ tipo: 'consulta', m: '8000004', origem: 'reconhecido', je: 'cancelado' });         // E: consulta, cancelou
await pessoa({ tipo: 'consulta', m: '8000005', origem: 'reconhecido', je: 'remarcado' });         // F: consulta, remarcou (NÃO é perda)
await pessoa({ semPedido: true });                                                                 // G: só abriu o chat
await pessoa({ tipo: 'exame', m: '8000006', origem: 'chat_api', je: 'agendado', teste: true });   // H: conversa de teste: fica fora
await pessoa({ tipo: 'consulta', m: '8000007', origem: 'equipe', je: 'atendido', dias: 5 });      // I: abriu o chat há 5 dias

const hoje = `(now() at time zone 'America/Sao_Paulo')::date`;
const ler = async (args) => { await como(ADM); try { return (await um(`select public.painel_indicadores_pessoas(${args}) as r`)).r; } finally { await como(null); } };
const igual = (a, b) => Object.keys(b).every((k) => a[k] === b[k]);

await caso('hoje, todos os tipos: os 5 números na mesma base de pessoas', async () => {
  const a = (await ler(`${hoje}, ${hoje}`)).atual;
  const esp = { procuraram: 7, atendidos: 3, agendaram: 5, robo: 2, robo_sem_atendente: 1, faltaram: 1, cancelaram: 1, faltaram_ou_cancelaram: 2 };
  return { ok: igual(a, esp), detalhe: JSON.stringify(a) };
});
await caso('remarcada não conta como cancelada nem falta (pessoa F)', async () => {
  const a = (await ler(`${hoje}, ${hoje}, null, false, 'consulta'`)).atual;
  return { ok: a.cancelaram === 1 && a.faltaram === 0 && a.agendaram === 2, detalhe: JSON.stringify(a) };
});
await caso('só exames: conta apenas pessoas com pedido de exame', async () => {
  const a = (await ler(`${hoje}, ${hoje}, null, false, 'exame'`)).atual;
  const esp = { procuraram: 3, atendidos: 2, agendaram: 3, robo: 2, robo_sem_atendente: 1, faltaram: 1, cancelaram: 0, faltaram_ou_cancelaram: 1 };
  return { ok: igual(a, esp), detalhe: JSON.stringify(a) };
});
await caso('conversa de teste fica fora; o administrador pode incluir', async () => {
  const sem = (await ler(`${hoje}, ${hoje}`)).atual, com = (await ler(`${hoje}, ${hoje}, null, true`)).atual;
  return { ok: sem.procuraram === 7 && com.procuraram === 8 && com.robo === 3, detalhe: `sem=${sem.procuraram} com=${com.procuraram}` };
});
await caso('período: quem abriu o chat há 5 dias só entra em período que cobre aquele dia', async () => {
  const hojeSo = (await ler(`${hoje}, ${hoje}`)).atual, semana = (await ler(`${hoje} - 6, ${hoje}`)).atual;
  return { ok: hojeSo.procuraram === 7 && semana.procuraram === 8 && semana.agendaram === 6, detalhe: `hoje=${hojeSo.procuraram} 7 dias=${semana.procuraram}/${semana.agendaram}` };
});
await caso('período anterior vem calculado (o dia de ontem está vazio, 5 dias atrás não entra)', async () => {
  const r = await ler(`${hoje}, ${hoje}`);
  return { ok: r.anterior && r.anterior.procuraram === 0 && r.tipo === null, detalhe: JSON.stringify(r.anterior) };
});
await caso('tipo inválido vira "todos"', async () => {
  const r = await ler(`${hoje}, ${hoje}, null, false, 'qualquer'`);
  return { ok: r.tipo === null && r.atual.procuraram === 7, detalhe: `tipo=${r.tipo}` };
});
await caso('por unidade: "Sem unidade definida" não devolve todo mundo; as quatro linhas somam o total (defeito de 23/11/2026: 42 = 39 + 42)', async () => {
  // Duas pessoas de hoje escolheram Desenvoar e uma escolheu CSI no formulário; as outras 4 ficam sem unidade.
  await db.exec(`insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao) values ('desenvoar', 'D', 'Desenvoar', 'x', 'pediatria', 'x'), ('csi', 'C', 'CSI', 'x', 'exame_consulta', 'x') on conflict (chave) do nothing`);
  await db.exec(`update public.conversas set unidade_inicial = 'desenvoar' where nome_informado in ('Paciente Teste 1', 'Paciente Teste 2');
                 update public.conversas set unidade_inicial = 'csi' where nome_informado = 'Paciente Teste 3'`);
  const n = async (u) => (await ler(`${hoje}, ${hoje}, '${u}'`)).atual.procuraram;
  const [csi, rmtc, des, sem] = [await n('csi'), await n('rmtc'), await n('desenvoar'), await n('sem')];
  return { ok: csi === 1 && rmtc === 0 && des === 2 && sem === 4 && csi + rmtc + des + sem === 7, detalhe: `csi=${csi} rmtc=${rmtc} desenvoar=${des} sem=${sem}` };
});
await caso('sem login (anônimo) é recusado', async () => {
  await como(null);
  try { await um(`select public.painel_indicadores_pessoas(${hoje}, ${hoje}) as r`); return { ok: false, detalhe: 'não recusou' }; }
  catch (e) { return { ok: /administrador e atendente/.test(e.message), detalhe: String(e.message).slice(0, 80) }; }
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
