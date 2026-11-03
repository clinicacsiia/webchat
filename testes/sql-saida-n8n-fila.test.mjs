// FLUXOGRAMA: entrada (fila-biometria.sql instalado sobre os stubs do Supabase + supabase/saida-n8n-fila.sql) -> validação (aplica a migração duas vezes; recusa se o módulo ainda citar o n8n) -> lógica (entrar na fila e reenviar chamam a Edge Function fila-emitir-link com o segredo no cabeçalho e SÓ o id no corpo; sem URL ou sem segredo nada é enviado; funções antigas e config antiga somem) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 03/11/2026 / Mudança: Implementação inicial
import { readFileSync } from 'node:fs';
import { criarBanco, funcao, REPO } from './stubs-supabase.mjs';

const db = await criarBanco({ segJwt: 'segredo-jwt-de-teste-com-mais-de-32-caracteres-aaaa', segN8n: 'segredo-fila-de-teste-bbbbbbbbbbbbbbbbbbbbbbbb' });
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push({ nome, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const afirmar = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe ?? ''); } catch (e) { registrar(nome, false, `exceção: ${e.message}`); } };
const erroDe = async (fn) => { try { await fn(); return null; } catch (e) { return e.message ?? String(e); } };
async function como(role, claims, fn) {
  await db.exec(`set role ${role}`);
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
  try { return await fn(); } finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); }
}
const rpc = (nome, ...args) => db.query(`select public.${nome}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args).then((x) => x.rows[0].r);

await db.exec(readFileSync(`${REPO}/supabase/fila-biometria.sql`, 'utf8'));
await db.exec(funcao('fila-chegada.sql', 'fila_aviso_segredo'));   // a função real do fila-chegada.sql (lê o segredo do Vault)
await db.exec(`insert into public.config (chave, valor) values ('fila_webhook_url', 'https://n8n.exemplo/webhook/antigo')`);
const STAFF = '11111111-1111-4111-8111-111111111111';
await db.exec(`insert into public.agentes (id, papel, ativo) values ('${STAFF}', 'atendente', true)`);
const staff = { sub: STAFF, role: 'authenticated' };

const migracao = readFileSync(`${REPO}/supabase/saida-n8n-fila.sql`, 'utf8');
await db.exec(migracao);
registrar('a migração aplica sobre o módulo da fila', true);
const segunda = await erroDe(() => db.exec(migracao));
registrar('a migração é idempotente (segunda aplicação sem erro)', segunda === null, segunda ?? '');

await afirmar('o módulo não cita mais o n8n nas funções de entrada e reenvio, e a função antiga e a chave antiga sumiram', async () => {
  const f = (await db.query(`select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in ('fila_entrar','fila_reenviar_link') and prosrc ilike '%n8n%'`)).rows;
  const velha = (await db.query(`select count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace and proname = 'fila_avisar_n8n'`)).rows[0].n;
  const chave = (await db.query(`select count(*)::int as n from public.config where chave = 'fila_webhook_url'`)).rows[0].n;
  const nova = (await db.query(`select valor from public.config where chave = 'fila_link_url'`)).rows[0]?.valor;
  return { ok: f.length === 0 && velha === 0 && chave === 0 && nova === '', detalhe: `citam=${f.length} velha=${velha} chaveVelha=${chave} nova="${nova}"` };
});

await afirmar('sem URL: entrar na fila não envia nada e informa link_agendado=false', async () => {
  const r = await como('authenticated', staff, () => rpc('fila_entrar', 'Teste Sem Url', 'sem.url@exemplo.com', null));
  const n = (await db.query(`select count(*)::int as n from net.chamadas`)).rows[0].n;
  await db.query(`delete from public.atendimentos where id = $1`, [r.atendimento_id]);
  await db.query(`delete from public.pacientes where id = $1`, [r.paciente_id]);
  return { ok: r.link_agendado === false && n === 0, detalhe: `link_agendado=${r.link_agendado} chamadas=${n}` };
});

await db.exec(`update public.config set valor = 'https://projeto.supabase.co/functions/v1/fila-emitir-link' where chave = 'fila_link_url'`);
let A1;
await afirmar('sem o segredo no Vault nada é enviado (falha fechada)', async () => {
  const r = await como('authenticated', staff, () => rpc('fila_entrar', 'Maria da Silva', 'maria@exemplo.com', '(71) 98871-0544'));
  A1 = r.atendimento_id;
  const n = (await db.query(`select count(*)::int as n from net.chamadas`)).rows[0].n;
  return { ok: Boolean(A1) && n === 0, detalhe: `chamadas=${n}` };
});

await db.query(`insert into vault.secrets_tbl (name, secret) values ('fila_aviso_segredo', 'segredo-de-aviso-de-teste')`);
await afirmar('reenviar o link chama a Edge Function com o segredo no cabeçalho e SÓ o id do atendimento no corpo', async () => {
  await como('authenticated', staff, () => rpc('fila_reenviar_link', A1));
  const c = (await db.query(`select url, body, headers from net.chamadas order by 1 limit 1`)).rows[0];
  const chaves = Object.keys(c.body).join(',');
  return { ok: c.url.endsWith('/functions/v1/fila-emitir-link') && chaves === 'atendimento_uuid' && c.body.atendimento_uuid === A1
    && c.headers['x-fila-aviso-segredo'] === 'segredo-de-aviso-de-teste', detalhe: `corpo=${chaves}` };
});

await afirmar('entrar na fila com tudo configurado informa link_agendado=true e envia', async () => {
  await db.query(`delete from net.chamadas`);
  const r = await como('authenticated', staff, () => rpc('fila_entrar', 'João Pereira Souza', 'joao@exemplo.com', null));
  const n = (await db.query(`select count(*)::int as n from net.chamadas`)).rows[0].n;
  return { ok: r.link_agendado === true && n === 1, detalhe: `link_agendado=${r.link_agendado} chamadas=${n}` };
});

await afirmar('a função nova não é executável pelo navegador (anon e authenticated)', async () => {
  const e = await como('anon', {}, () => erroDe(() => rpc('fila_avisar_link', A1)));
  const e2 = await como('authenticated', staff, () => erroDe(() => rpc('fila_avisar_link', A1)));
  return { ok: /permission denied/i.test(e ?? '') && /permission denied/i.test(e2 ?? ''), detalhe: `${e} | ${e2}` };
});

const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
