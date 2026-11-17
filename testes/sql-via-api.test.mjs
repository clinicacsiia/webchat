// FLUXOGRAMA: entrada (clone da produção + supabase/klingo-via-api-parte1..3.sql; marcações e conversas INVENTADAS) -> validação (coluna via_api, lote aceita "a", permissões) -> lógica (marcação pela API x por pessoa, com e sem atendente na conversa; conversa de teste e marcação sem conversa ficam fora) -> saída (painel_indicadores_plataforma.quem_marcou soma o total)
// Versão 1.0 — 17/11/2026 / Mudança: Implementação inicial (responsável biclinicacsi = API do chat).
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + String(e.message).split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const { db, falhas } = await criarBancoProducao();
const { um, como } = ajudantes(db);

for (const p of [1, 2, 3]) await db.exec(readFileSync(`${REPO}/supabase/klingo-via-api-parte${p}.sql`, 'utf8'));

const ADM = '00000000-0000-4000-8000-0000000000c1';
await db.exec(`insert into auth.users (id, email) values ('${ADM}', 'adm@exemplo.invalid'); insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Admin Teste', 'adm@exemplo.invalid', 'admin', true)`);
const hoje = (await um(`select (now() at time zone 'America/Sao_Paulo')::date::text as d`)).d;
let seq = 0;
// conversa real ou de teste; humano = a equipe já escreveu (primeiro_humano_em preenchido)
const chat = async ({ humano = false, teste = false, marc }) => {
  seq++;
  const ct = (await um(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, ['Contato ' + seq, '7198888' + String(1000 + seq)])).id;
  const conv = (await um(`insert into public.conversas (contato_id, nome_informado, status, teste, primeiro_humano_em, ia_ativa) values ($1, $2, 'em_atendimento', $3, $4, false) returning id`,
    [ct, 'Pessoa Teste ' + seq, teste, humano ? new Date().toISOString() : null])).id;
  await db.query(`insert into public.pre_agendamentos (conversa_id, tipo, procedimento, status, etapa, paciente, klingo_marcacoes) values ($1, 'exame', 'RAIO X', 'agendado', 'pronto', '{}'::jsonb, $2)`, [conv, [marc]]);
  return conv;
};
const linha = (o) => ({ m: '1', em: hoje, para: hoje, o: '', s: 'Aberta', u: 'CLÍNICA DE SAÚDE E IMAGEM - CSI', pl: 'Particular', n: 'Paciente', fh: '', fh2: '', nasc: '2000-01-01', cpfh: '', emh: '', vz: [], ...o });
const lote = async (linhas) => (await um(`select public.klingo_conferir_lote($1::jsonb) as r`, [JSON.stringify(linhas)])).r;
const ler = async () => { await como(ADM); try { return (await um(`select public.painel_indicadores_plataforma($1::date, $1::date, null, false) as r`, [hoje])).r; } finally { await como(null); } };

// 501: API, conversa SEM atendente | 502: API, conversa COM atendente | 503: pessoa, COM atendente | 504: pessoa, SEM atendente (cancelada) | 505: API mas conversa de TESTE | 506: API sem conversa nenhuma
await chat({ humano: false, marc: '501' }); await chat({ humano: true, marc: '502' }); await chat({ humano: true, marc: '503' }); await chat({ humano: false, marc: '504' }); await chat({ teste: true, marc: '505' });
const L = [linha({ m: '501', a: true }), linha({ m: '502', a: true }), linha({ m: '503', a: false }), linha({ m: '504', a: false, s: 'Cancelada' }), linha({ m: '505', a: true }), linha({ m: '506', a: true }), linha({ m: '507' })];

await caso('o clone da produção monta sem falhas e as 3 partes aplicam', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('coluna via_api existe, é boolean e começa em falso', async () => {
  const c = await um(`select data_type, column_default, is_nullable from information_schema.columns where table_schema='public' and table_name='klingo_conferencia' and column_name='via_api'`);
  return { ok: c && c.data_type === 'boolean' && /false/.test(c.column_default) && c.is_nullable === 'NO', detalhe: JSON.stringify(c) };
});
const r1 = await lote(L);
await caso('o lote grava "a" em via_api (verdadeiro, falso e ausente = falso) e não guarda nome de responsável', async () => {
  const v = Object.fromEntries((await db.query(`select m, via_api from public.klingo_conferencia order by m`)).rows.map((x) => [x.m, x.via_api]));
  const cols = (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name='klingo_conferencia'`)).rows.map((x) => x.column_name);
  return { ok: r1.lidas === 7 && v['501'] && v['502'] && !v['503'] && !v['504'] && v['505'] && v['506'] && v['507'] === false && !cols.some((c) => /respons.*nome|usuario|login/.test(c)), detalhe: JSON.stringify(v) };
});
await caso('reler a mesma marcação atualiza via_api (histórico antigo passa a ser reconhecido)', async () => {
  await lote([linha({ m: '503', a: true })]); const a = (await um(`select via_api from public.klingo_conferencia where m='503'`)).via_api;
  await lote([linha({ m: '503', a: false })]); const b = (await um(`select via_api from public.klingo_conferencia where m='503'`)).via_api;
  return { ok: a === true && b === false, detalhe: `${a} ${b}` };
});
const R = await ler();
await caso('quem_marcou: só marcações ligadas a conversa real; API sem atendente 1, API com atendente 1, pessoa com atendente 1, pessoa sem atendente 1', async () => {
  const q = R.quem_marcou;
  return { ok: q.api_sem_atendente === 1 && q.api_com_atendente === 1 && q.pessoa_com_atendente === 1 && q.pessoa_sem_atendente === 1, detalhe: JSON.stringify(q) };
});
await caso('as quatro faixas somam o total do painel (conversa de teste e marcação sem conversa ficam fora)', async () => {
  const q = R.quem_marcou, soma = q.api_sem_atendente + q.api_com_atendente + q.pessoa_com_atendente + q.pessoa_sem_atendente;
  return { ok: soma === R.total.total && R.total.total === 4 && R.total.canceladas === 1, detalhe: `soma=${soma} total=${R.total.total}` };
});
await caso('a conversa de teste entra em quem_marcou só quando o painel pede para incluir teste', async () => {
  await como(ADM); const t = (await um(`select public.painel_indicadores_plataforma($1::date, $1::date, null, true) as r`, [hoje])).r; await como(null);
  return { ok: t.quem_marcou.api_sem_atendente === 2 && t.total.total === 5, detalhe: JSON.stringify(t.quem_marcou) };
});
await caso('permissões: o lote é só do servidor; o painel só para quem está logado', async () => {
  const p = (await um(`select has_function_privilege('anon', 'public.klingo_conferir_lote(jsonb)', 'execute') a1, has_function_privilege('authenticated', 'public.klingo_conferir_lote(jsonb)', 'execute') a2, has_function_privilege('service_role', 'public.klingo_conferir_lote(jsonb)', 'execute') a3,
    has_function_privilege('anon', 'public.painel_indicadores_plataforma(date,date,text,boolean)', 'execute') b1, has_function_privilege('authenticated', 'public.painel_indicadores_plataforma(date,date,text,boolean)', 'execute') b2`));
  return { ok: !p.a1 && !p.a2 && p.a3 && !p.b1 && p.b2, detalhe: JSON.stringify(p) };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
