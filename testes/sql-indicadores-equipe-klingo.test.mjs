// FLUXOGRAMA: entrada (clone da produção + supabase/indicadores-equipe-klingo.sql; conversas e marcações INVENTADAS) -> validação (só admin/atendente leem; conversa de teste fica fora; período e unidade respeitados) -> lógica (confere o bloco "Equipe no Klingo" do topo da aba Indicadores: marcações pelo dia da marcação e conversas encerradas como "Agendado" pelo dia do encerramento) -> saída (PASS/FAIL e código de saída)
// Versão 1.0 — 19/11/2026 / Mudança: Implementação inicial.
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + String(e.message).split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const { db } = await criarBancoProducao();
const { um, como } = ajudantes(db);

const ADM = '00000000-0000-4000-8000-0000000000d1', ANA = '00000000-0000-4000-8000-0000000000d2';
await db.exec(`
  insert into auth.users (id, email) values ('${ADM}', 'adm@exemplo.invalid'), ('${ANA}', 'ana@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Admin Teste', 'adm@exemplo.invalid', 'admin', true), ('${ANA}', 'Ana Teste', 'ana@exemplo.invalid', 'atendente', true);
`);
// A coluna via_api (supabase/klingo-via-api-parte1.sql, PR 239) já existe na produção, mas o retrato da main ainda não a traz: cria no clone igual à produção.
await db.exec(`alter table public.klingo_conferencia add column if not exists via_api boolean not null default false;`);
await db.exec(readFileSync(`${REPO}/supabase/indicadores-equipe-klingo.sql`, 'utf8'));
await db.exec(`delete from public.klingo_conferencia; delete from public.pre_agendamentos; delete from public.mensagens; delete from public.conversas;`);

let seq = 0;
// Conversa inventada. motivo = como foi encerrada; encerrada = dias atrás (null = aberta); un = unidade responsável.
const conversa = async ({ motivo = null, encerrada = null, un = 'desenvoar', teste = false } = {}) => {
  seq++;
  const ct = (await um(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, ['Paciente Teste ' + seq, '7198' + (5000000 + seq)])).id;
  return (await um(`insert into public.conversas (contato_id, nome_informado, status, ia_ativa, teste, unidade_responsavel, motivo_encerramento, encerrada_em, criado_em)
    values ($1, $2, $3, false, $4, $5, $6, case when $7::int is null then null else now() - ($7::int * interval '1 day') end, now() - interval '10 days') returning id`,
    [ct, 'Paciente Teste ' + seq, encerrada == null ? 'em_atendimento' : 'encerrada', teste, un, motivo, encerrada])).id;
};
let nm = 0;
// Marcação inventada no Klingo. dias = quantos dias atrás foi MARCADA; origem como o Klingo mostra; api = marcada pelo robô.
const marcacao = async ({ dias = 0, origem = 'sem_origem', status = 'Aberta', un = 'Desenvoar - Pediatria', api = false, conversa = null } = {}) => {
  nm++;
  await db.query(`insert into public.klingo_conferencia (m, marcado_em, exame_em, origem, status_klingo, unidade, conversa_id, via_api, ligacao)
    values ($1, (now() at time zone 'America/Sao_Paulo')::date - $2::int, (now() at time zone 'America/Sao_Paulo')::date + 3, $3, $4, $5, $6, $7, $8)`,
    ['9' + String(100000 + nm), dias, origem, status, un, conversa, api, conversa ? 'pedido' : null]);
};

// ---- Desenvoar, hoje (dias = 0) ----
const c1 = await conversa({ motivo: 'agendado', encerrada: 0 });   // encerrada como Agendado, marcada pela equipe
const c2 = await conversa({ motivo: 'agendado', encerrada: 0 });   // encerrada como Agendado, marcada pelo robô
const c3 = await conversa({ motivo: 'agendado', encerrada: 0 });   // encerrada como Agendado, SEM marcação no Klingo
const c4 = await conversa({ motivo: 'agendado', encerrada: 0, teste: true });   // teste: fica fora
await conversa({ motivo: 'apenas_informacoes', encerrada: 0 });   // outro motivo: não entra
await conversa({ motivo: 'agendado', encerrada: 0, un: 'csi' });  // outra unidade
const c7 = await conversa({ motivo: 'agendado', encerrada: 4 });   // encerrada há 4 dias
await marcacao({ origem: 'Whatsapp', conversa: c1 });
await marcacao({ origem: 'sem_origem', api: true, conversa: c2 });
await marcacao({ origem: 'Telefone' });
await marcacao({ origem: 'Recepção' });
await marcacao({ origem: 'Whatsapp', status: 'Cancelada' });
await marcacao({ origem: 'Whatsapp', conversa: c4 });                     // marcação de conversa de teste: fica fora
await marcacao({ origem: 'Whatsapp', un: 'CSI - Centro' });               // outra unidade
await marcacao({ origem: 'Telefone', dias: 4, conversa: c7 });             // marcada há 4 dias

const hoje = `(now() at time zone 'America/Sao_Paulo')::date`;
const ler = async (args) => { await como(ADM); try { return (await um(`select public.painel_indicadores_equipe_klingo(${args}) as r`)).r; } finally { await como(null); } };
const igual = (a, b) => Object.keys(b).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));

await caso('Desenvoar hoje: marcações do Klingo (equipe x robô x canceladas)', async () => {
  const k = (await ler(`${hoje}, ${hoje}, 'desenvoar'`)).atual.klingo;
  return { ok: igual(k, { total: 5, robo: 1, equipe: 4, canceladas: 1 }), detalhe: JSON.stringify(k) };
});
await caso('Desenvoar hoje: por origem conta só a equipe (o robô não entra)', async () => {
  const o = (await ler(`${hoje}, ${hoje}, 'desenvoar'`)).atual.klingo.por_origem;
  return { ok: o.Whatsapp === 2 && o.Telefone === 1 && o['Recepção'] === 1 && o.sem_origem === undefined, detalhe: JSON.stringify(o) };
});
await caso('Desenvoar hoje: conversas encerradas como Agendado (com marcação da equipe, do robô e sem marcação)', async () => {
  const e = (await ler(`${hoje}, ${hoje}, 'desenvoar'`)).atual.encerradas;
  return { ok: igual(e, { agendado: 3, com_marcacao: 2, equipe: 1, robo: 1, sem_marcacao: 1 }), detalhe: JSON.stringify(e) };
});
await caso('todas as unidades somam as outras (CSI entra)', async () => {
  const a = (await ler(`${hoje}, ${hoje}`)).atual;
  return { ok: a.klingo.total === 6 && a.encerradas.agendado === 4 && a.encerradas.sem_marcacao === 2, detalhe: JSON.stringify(a) };
});
await caso('período de 7 dias traz as de 4 dias atrás; o período anterior de hoje fica vazio', async () => {
  const r = await ler(`${hoje} - 6, ${hoje}, 'desenvoar'`), h = await ler(`${hoje}, ${hoje}, 'desenvoar'`);
  return { ok: r.atual.klingo.total === 6 && r.atual.encerradas.agendado === 4 && h.anterior.klingo.total === 0, detalhe: `7d=${r.atual.klingo.total}/${r.atual.encerradas.agendado} anterior_hoje=${h.anterior.klingo.total}` };
});
await caso('conversa de teste fica fora; o administrador pode incluir', async () => {
  const sem = (await ler(`${hoje}, ${hoje}, 'desenvoar'`)).atual, com = (await ler(`${hoje}, ${hoje}, 'desenvoar', true`)).atual;
  return { ok: sem.encerradas.agendado === 3 && com.encerradas.agendado === 4 && com.klingo.total === 6, detalhe: `sem=${sem.encerradas.agendado}/${sem.klingo.total} com=${com.encerradas.agendado}/${com.klingo.total}` };
});
await caso('unidade inválida vira "todas"', async () => {
  const r = await ler(`${hoje}, ${hoje}, 'qualquer'`);
  return { ok: r.unidade === null && r.atual.klingo.total === 6, detalhe: `unidade=${r.unidade}` };
});
await caso('sem login (anônimo) é recusado', async () => {
  await como(null);
  try { await um(`select public.painel_indicadores_equipe_klingo(${hoje}, ${hoje}) as r`); return { ok: false, detalhe: 'não recusou' }; }
  catch (e) { return { ok: /administrador e atendente/.test(e.message), detalhe: String(e.message).slice(0, 80) }; }
});
await caso('a função interna não é executável por anon nem authenticated', async () => {
  const r = await um(`select has_function_privilege('anon', 'public.ind_equipe_klingo_periodo(date,date,text,boolean)', 'execute') as a, has_function_privilege('authenticated', 'public.ind_equipe_klingo_periodo(date,date,text,boolean)', 'execute') as b, has_function_privilege('anon', 'public.painel_indicadores_equipe_klingo(date,date,text,boolean)', 'execute') as c`);
  return { ok: !r.a && !r.b && !r.c, detalhe: JSON.stringify(r) };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
