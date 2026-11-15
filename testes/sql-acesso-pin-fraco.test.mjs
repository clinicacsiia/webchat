// FLUXOGRAMA: entrada (o retrato da produção + migrações do acesso rápido + acesso-rapido-pin-fraco.sql; cadastros INVENTADOS) -> validação (app_pin_fraco para uma lista de PINs; criar cadastro, trocar e recuperar o PIN com PIN óbvio e com PIN bom) -> lógica (PIN óbvio é recusado com erro pin_fraco e nada é gravado; PIN bom passa; quem já tem PIN não é afetado) -> saída (casos PASS/FAIL)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (auditoria: o PIN aceitava 0000 e 1234).
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo } = ajudantes(db);
for (const f of ['acesso-rapido-paciente', 'acesso-rapido-chat', 'acesso-rapido-pendencias', 'acesso-rapido-pin-obrigatorio']) await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8'));
const sql = readFileSync(`${REPO}/supabase/acesso-rapido-pin-fraco.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);

// Cadastro ANTES da regra: quem já tem PIN (mesmo óbvio) continua entrando.
await anonimo();
const antigo = (await q(`select public.app_cadastrar(p_telefone => '71991230777', p_nome => 'Pedro Antigo Teste', p_nascimento => '1980-01-02', p_pin => '1234', p_filhos => '[]'::jsonb, p_aparelho => 'teste') r`))[0].r;
await db.exec('reset role');
await caso('antes da regra: PIN 1234 era aceito (é o que a auditoria achou)', async () => ({ ok: antigo.ok === true }));

await caso('pin-fraco.sql aplica duas vezes sem erro (idempotente) e entra uma vez em cada uma das 4 funções', async () => {
  await db.exec(sql); await db.exec(sql);
  const r = await q(`select p.proname, (length(pg_get_functiondef(p.oid)) - length(replace(pg_get_functiondef(p.oid), 'app_pin_fraco', ''))) / length('app_pin_fraco') as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('app_cadastrar','app_conta_antiga_migrar','app_pin_trocar','app_pin_esqueci') order by 1`);
  return { ok: r.length === 4 && r.every((x) => Number(x.n) === 1), detalhe: r.map((x) => `${x.proname}=${x.n}`).join(' ') };
});
await caso('app_pin_fraco: recusa repetidos, sequências e pares repetidos; aceita PINs comuns que não são óbvios', async () => {
  const fracos = ['0000', '1111', '9999', '1234', '4321', '0123', '6789', '9876', '1212', '3434', '1122', '7799'];
  const bons = ['1357', '2468', '1380', '4729', '0852', '1990', '2580', '7391'];
  const f = (await q(`select p, public.app_pin_fraco(p) as r from unnest($1::text[]) p`, [fracos])), b = (await q(`select p, public.app_pin_fraco(p) as r from unnest($1::text[]) p`, [bons]));
  const falhaF = f.filter((x) => !x.r).map((x) => x.p), falhaB = b.filter((x) => x.r).map((x) => x.p);
  return { ok: falhaF.length === 0 && falhaB.length === 0, detalhe: `fracos não pegos: ${falhaF.join(',') || '-'}; bons recusados: ${falhaB.join(',') || '-'}` };
});
const cad = async (tel, pin) => { await anonimo(); try { return (await q(`select public.app_cadastrar(p_telefone => $1, p_nome => 'Ana Souza Teste', p_nascimento => '1988-04-12', p_pin => $2, p_filhos => '[]'::jsonb, p_aparelho => 'teste') r`, [tel, pin]))[0].r; } finally { await db.exec('reset role'); } };
await caso('criar cadastro com PIN óbvio: recusa com erro pin_fraco e a mensagem explica; nada é gravado', async () => {
  const r = await cad('71991230001', '0000'); const n = Number((await um(`select count(*)::int n from public.app_paciente where telefone = '71991230001'`)).n);
  return { ok: r.ok === false && r.erro === 'pin_fraco' && /menos óbvio/.test(r.mensagem) && n === 0, detalhe: JSON.stringify(r).slice(0, 120) };
});
await caso('criar cadastro com PIN bom: passa', async () => {
  const r = await cad('71991230001', '1357'); return { ok: r.ok === true, detalhe: r.erro || '' };
});
await caso('quem já tinha PIN óbvio continua entrando (a regra é só para PIN novo)', async () => {
  await anonimo(); let r; try { r = (await q(`select public.app_login(p_telefone => '71991230777', p_pin => '1234', p_aparelho => 'outro') r`))[0].r; } finally { await db.exec('reset role'); }
  return { ok: r.ok === true, detalhe: r.erro || '' };
});
await caso('trocar o PIN para um óbvio é recusado; para um bom, passa', async () => {
  const tok = (await cad('71991230002', '1357')).token;
  await anonimo(); let a, b; try {
    a = (await q(`select public.app_pin_trocar(p_token => $1, p_atual => '1357', p_novo => '1111') r`, [tok]))[0].r;
    b = (await q(`select public.app_pin_trocar(p_token => $1, p_atual => '1357', p_novo => '2468') r`, [tok]))[0].r;
  } finally { await db.exec('reset role'); }
  return { ok: a.ok === false && a.erro === 'pin_fraco' && b.ok === true, detalhe: `${a.erro || a.ok} | ${b.erro || b.ok}` };
});
await caso('recuperar o PIN (esqueci) com PIN óbvio é recusado', async () => {
  await anonimo(); let a; try {
    a = (await q(`select public.app_pin_esqueci(p_telefone => '71991230002', p_nome => 'Ana Souza Teste', p_nascimento => '1988-04-12', p_pin_novo => '4321', p_aparelho => 'x') r`))[0].r;
  } finally { await db.exec('reset role'); }
  return { ok: a.ok === false && a.erro === 'pin_fraco', detalhe: JSON.stringify(a).slice(0, 120) };
});
await caso('a função app_pin_fraco não pode ser chamada pelo público', async () => {
  await anonimo(); let negou = false; try { await q(`select public.app_pin_fraco('1234')`); } catch (e) { negou = /permission denied/.test(e.message); } finally { await db.exec('reset role'); }
  return { ok: negou };
});

console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} casos passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
