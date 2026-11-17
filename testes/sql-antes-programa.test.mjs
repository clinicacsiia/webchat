// FLUXOGRAMA: entrada (clone da produção + klingo-via-api-parte1..3 + indicadores-antes-do-programa-parte1..2; marcações INVENTADAS) -> validação (chave da config, texto quebrado não derruba o painel) -> lógica (clinica_todas conta Aberta + Cancelada de todos os canais e ignora Bloqueada; filtro de unidade) -> saída (antes_do_programa devolvido ao painel)
// Versão 1.0 — 17/11/2026 / Mudança: Implementação inicial (comparativo antes x depois do programa).
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const caso = async (nome, fn) => { let ok = false, d = ''; try { ({ ok, detalhe: d = '' } = await fn()); } catch (e) { d = 'exceção: ' + String(e.message).split('\n')[0]; } resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${d ? '  -- ' + d : ''}`); };
const { db, falhas } = await criarBancoProducao();
const { um, como } = ajudantes(db);
for (const a of ['klingo-via-api-parte1', 'klingo-via-api-parte2', 'klingo-via-api-parte3', 'indicadores-antes-do-programa-parte1', 'indicadores-antes-do-programa-parte2']) await db.exec(readFileSync(`${REPO}/supabase/${a}.sql`, 'utf8'));

const ADM = '00000000-0000-4000-8000-0000000000d1';
await db.exec(`insert into auth.users (id, email) values ('${ADM}', 'adm@exemplo.invalid'); insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Admin Teste', 'adm@exemplo.invalid', 'admin', true)`);
const hoje = (await um(`select (now() at time zone 'America/Sao_Paulo')::date::text as d`)).d;
const linha = (o) => ({ m: '1', em: hoje, para: hoje, o: '', s: 'Aberta', u: 'CLÍNICA DE SAÚDE E IMAGEM - CSI', pl: 'Particular', n: 'Paciente', fh: '', fh2: '', nasc: '2000-01-01', cpfh: '', emh: '', vz: [], ...o });
await um(`select public.klingo_conferir_lote($1::jsonb) as r`, [JSON.stringify([
  linha({ m: '801' }), linha({ m: '802', s: 'Cancelada' }), linha({ m: '803', u: 'DESENVOAR' }), linha({ m: '804', u: 'DESENVOAR', s: 'Cancelada' }), linha({ m: '805', s: 'Bloqueada' }),
  linha({ m: '806', u: 'CLÍNICA DE SAÚDE E IMAGEM - RM/TC', a: true })])]);
const ler = async (un = null) => { await como(ADM); try { return (await um(`select public.painel_indicadores_plataforma($1::date, $1::date, $2, false) as r`, [hoje, un])).r; } finally { await como(null); } };

await caso('o clone monta sem falhas e as partes aplicam', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('a chave base_antes_programa existe, é JSON válido e traz Setembro (30 dias) e Outubro (28 dias) por unidade', async () => {
  const v = JSON.parse((await um(`select valor from public.config where chave = 'base_antes_programa'`)).valor);
  const soma = (b) => Object.values(b.por_unidade).reduce((q, u) => q + u.abertas + u.canceladas, 0);
  return { ok: v.blocos.length === 2 && v.blocos[0].dias === 30 && v.blocos[1].dias === 28 && soma(v.blocos[0]) === 8548 && soma(v.blocos[1]) === 7721 && v.inicio_programa === '2026-10-29' && !/paciente|cpf|nome/i.test(JSON.stringify(v.blocos)), detalhe: `${soma(v.blocos[0])} ${soma(v.blocos[1])}` };
});
const R = await ler();
await caso('clinica_todas: conta Aberta e Cancelada de TODOS os canais (com ou sem conversa) e ignora Bloqueada', async () => ({ ok: R.clinica_todas.total === 5 && R.clinica_todas.canceladas === 2, detalhe: JSON.stringify(R.clinica_todas) }));
await caso('clinica_todas respeita o filtro de unidade', async () => {
  const d = await ler('desenvoar'), r = await ler('rmtc');
  return { ok: d.clinica_todas.total === 2 && d.clinica_todas.canceladas === 1 && r.clinica_todas.total === 1 && r.clinica_todas.canceladas === 0, detalhe: JSON.stringify([d.clinica_todas, r.clinica_todas]) };
});
await caso('antes_do_programa chega ao painel (blocos, início do programa e fonte)', async () => ({ ok: R.antes_do_programa && R.antes_do_programa.blocos.length === 2 && R.antes_do_programa.inicio_programa === '2026-10-29' && /#14554/.test(R.antes_do_programa.fonte), detalhe: JSON.stringify(R.antes_do_programa).slice(0, 120) }));
await caso('texto quebrado na config não derruba o painel: antes_do_programa vira nulo e o resto segue', async () => {
  await db.query(`update public.config set valor = '{quebrado' where chave = 'base_antes_programa'`);
  const q = await ler();
  return { ok: q.antes_do_programa === null && q.clinica_todas.total === 5 && q.total != null, detalhe: JSON.stringify(q.antes_do_programa) };
});
await caso('sem a chave na config: antes_do_programa é nulo', async () => {
  await db.query(`delete from public.config where chave = 'base_antes_programa'`);
  const q = await ler();
  return { ok: q.antes_do_programa === null, detalhe: JSON.stringify(q.antes_do_programa) };
});
await caso('permissões da função seguem iguais (logado sim, anônimo não)', async () => {
  const p = await um(`select has_function_privilege('anon', 'public.painel_indicadores_plataforma(date,date,text,boolean)', 'execute') a, has_function_privilege('authenticated', 'public.painel_indicadores_plataforma(date,date,text,boolean)', 'execute') b`);
  return { ok: !p.a && p.b, detalhe: JSON.stringify(p) };
});
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
