// FLUXOGRAMA: entrada (o retrato da produção + acesso-conta-antiga-unir.sql, aplicado duas vezes; contas antigas, acessos rápidos e conversas INVENTADOS)
//   -> validação (a união exige a sessão da conta antiga (senha) E o PIN do acesso rápido; sem sessão, PIN vencido, outra pessoa, conta ou acesso já ligados são recusados)
//   -> lógica (liga conta e acesso, completa e-mail/CPF sem sobrescrever, traz as conversas da conta sem virar novidade, serve também quando só o e-mail bate; a migração normal passa a trazer as conversas)
//   -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (quem tem conta antiga e PIN passa a ser uma pessoa só)
// Dados: todos inventados neste arquivo (CPF 529.982.247-25 é o de exemplo que passa na conferência). Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, como, anonimo } = ajudantes(db);
const sql = readFileSync(`${REPO}/supabase/acesso-conta-antiga-unir.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('a migração aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.query(`insert into public.config (chave, valor) values ('app_acesso_modo', 'sim') on conflict (chave) do update set valor = excluded.valor`);

const CPF = '52998224725';
const U = { ana: '00000000-0000-4000-8000-000000000001', estranha: '00000000-0000-4000-8000-000000000002', cris: '00000000-0000-4000-8000-000000000003', dora: '00000000-0000-4000-8000-000000000004' };
const rpcAnon = async (fn, args = {}) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  await anonimo();
  try { return (await q(`select public.${fn}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
const rpcConta = async (uid, fn, args = {}) => {
  await como(uid);
  const ks = Object.keys(args);
  try { return (await q(`select public.${fn}(${ks.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, ks.map((k) => args[k])))[0].r; }
  finally { await db.exec('reset role'); }
};
const dono = (s, p) => q(s, p);

// Pessoas: Ana (acesso rápido + conta antiga, mesmo celular); Bia (só acesso rápido, outro celular); Cris (acesso com e-mail, conta SEM celular); Dora (só conta antiga)
const cad = (tel, nome, nasc, pin = '1357') => rpcAnon('app_cadastrar', { p_telefone: tel, p_nome: nome, p_nascimento: nasc, p_pin: pin, p_filhos: [], p_aparelho: 'teste' });
const ana = await cad('71991230001', 'Ana Souza Teste', '1988-04-12');
const bia = await cad('71991230002', 'Bia Amiga Teste', '1990-01-01');
const cris = await cad('71991230005', 'Cris Outra Teste', '1985-05-05', '2468');
await dono(`update public.app_paciente set email = 'cris@exemplo.invalid' where telefone = '71991230005'`);
const pac = (await dono(`insert into public.pacientes (nome, nome_norm, telefones, email, dt_nasc, cpf) values ('Ana Souza Teste', 'ana souza teste', array['71991230001'], 'ana@exemplo.invalid', '1988-04-12', '${CPF}') returning id`))[0].id;
await db.exec(`
  insert into auth.users (id, email) values ('${U.ana}', 'ana@exemplo.invalid'), ('${U.estranha}', 'estranha@exemplo.invalid'), ('${U.cris}', 'cris@exemplo.invalid'), ('${U.dora}', 'dora@exemplo.invalid');
  insert into public.contas_paciente (id, email, nome, telefone, paciente_id) values ('${U.ana}', 'ana@exemplo.invalid', 'Ana Souza Teste', '71991230001', '${pac}');
  insert into public.contas_paciente (id, email, nome, telefone) values ('${U.estranha}', 'estranha@exemplo.invalid', 'Pessoa Estranha', '71991230099');
  insert into public.contas_paciente (id, email, nome) values ('${U.cris}', 'cris@exemplo.invalid', 'Cris Outra Teste');
  insert into public.contas_paciente (id, email, nome, telefone) values ('${U.dora}', 'dora@exemplo.invalid', 'Dora Sem Pin Teste', '71991230004');
`);
// conversas feitas pela conta da Ana (uma dela, uma de um filho) e pela da Dora
const conv = async (conta, nome, tel, filho = null) => {
  await dono(`update public.conversas set criado_em = criado_em - interval '2 hours'`);
  const r = await rpcAnon('chat_iniciar', { p_nome: nome, p_telefone: tel, p_email: 'x@exemplo.invalid', p_aceite: true });
  await dono(`update public.conversas set conta_id = $1${filho ? `, paciente_tipo = 'filho', paciente_nome = '${filho}'` : ''} where id = $2`, [conta, r.conversa_id]);
  return r.conversa_id;
};
const c1 = await conv(U.ana, 'Ana Souza Teste', '71991230001');
const c2 = await conv(U.ana, 'Ana Souza Teste', '71991230001', 'Leo Souza Teste');
const cd = await conv(U.dora, 'Dora Sem Pin Teste', '71991230004');
const ligacao = (tel) => dono(`select conta_antiga_id, email, cpf, paciente_sugerido_id from public.app_paciente where telefone = $1`, [tel]).then((r) => r[0]);
const conversasDe = (tel) => dono(`select ac.conversa_id, ac.eu, ac.pessoa_nome, ac.visto_sig from public.app_conversa ac join public.app_paciente a on a.id = ac.paciente_id where a.telefone = $1 order by ac.eu desc`, [tel]);

await caso('sem estar logado na conta antiga (anon) não chama nem a união nem a importação', async () => {
  const r = await dono(`select has_function_privilege('anon', 'public.app_conta_antiga_unir(text)', 'execute') a, has_function_privilege('authenticated', 'public.app_conta_antiga_unir(text)', 'execute') b,
    has_function_privilege('anon', 'public.app_conta_antiga_importar(uuid, uuid)', 'execute') c, has_function_privilege('authenticated', 'public.app_conta_antiga_importar(uuid, uuid)', 'execute') d`);
  return { ok: r[0].a === false && r[0].b === true && r[0].c === false && r[0].d === false, detalhe: JSON.stringify(r[0]) };
});
await caso('estado de partida: nenhum acesso ligado a conta antiga e as conversas da conta não aparecem no acesso rápido', async () => {
  const l = await ligacao('71991230001');
  return { ok: l.conta_antiga_id === null && (await conversasDe('71991230001')).length === 0 };
});
await caso('PIN vencido (30 min): recusa com "bloqueado" e não liga nada', async () => {
  await dono(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const r = await rpcConta(U.ana, 'app_conta_antiga_unir', { p_token: ana.token });
  await dono(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  return { ok: r.ok === false && r.erro === 'bloqueado' && (await ligacao('71991230001')).conta_antiga_id === null, detalhe: JSON.stringify(r) };
});
await caso('código de aparelho desconhecido: recusa com "sessao"', async () => {
  const r = await rpcConta(U.ana, 'app_conta_antiga_unir', { p_token: 'nao-existe' });
  return { ok: r.ok === false && r.erro === 'sessao', detalhe: JSON.stringify(r) };
});
await caso('mesma pessoa (celular igual): liga a conta ao acesso, completa e-mail e CPF do cadastro da clínica e traz as 2 conversas (a dela e a do filho)', async () => {
  const r = await rpcConta(U.ana, 'app_conta_antiga_unir', { p_token: ana.token });
  const l = await ligacao('71991230001'), cs = await conversasDe('71991230001');
  return { ok: r.ok === true && r.ja_unida === false && r.conversas === 2 && l.conta_antiga_id === U.ana && l.email === 'ana@exemplo.invalid' && l.cpf === CPF && l.paciente_sugerido_id === pac
    && cs.length === 2 && cs[0].eu === true && cs[0].pessoa_nome === 'Ana Souza Teste' && cs[1].eu === false && cs[1].pessoa_nome === 'Leo Souza Teste', detalhe: JSON.stringify(r) };
});
await caso('as conversas que entram NÃO viram "novidade" (já nascem vistas)', async () => {
  const cs = await conversasDe('71991230001');
  return { ok: cs.length === 2 && cs.every((c) => c.visto_sig !== null) };
});
await caso('chamar de novo é seguro: "ja_unida", sem duplicar conversas', async () => {
  const r = await rpcConta(U.ana, 'app_conta_antiga_unir', { p_token: ana.token });
  return { ok: r.ok === true && r.ja_unida === true && r.conversas === 0 && (await conversasDe('71991230001')).length === 2, detalhe: JSON.stringify(r) };
});
await caso('a conta ligada sai da lista "Contas antigas sem PIN" do painel e a conta antiga continua existindo', async () => {
  const sem = await dono(`select id from public.contas_paciente c where not exists (select 1 from public.app_paciente a where a.conta_antiga_id = c.id)`);
  const existe = await dono(`select count(*)::int n from public.contas_paciente where id = $1`, [U.ana]);
  return { ok: !sem.some((x) => x.id === U.ana) && sem.length === 3 && existe[0].n === 1, detalhe: `${sem.length} sem PIN` };
});
await caso('outra pessoa (celular e e-mail diferentes): recusa com "outra_pessoa" e não liga nada', async () => {
  const r = await rpcConta(U.estranha, 'app_conta_antiga_unir', { p_token: bia.token });
  return { ok: r.ok === false && r.erro === 'outra_pessoa' && (await ligacao('71991230002')).conta_antiga_id === null, detalhe: JSON.stringify(r) };
});
await caso('conta que já está ligada a outro acesso: recusa com "ja_ligada" (a Bia não leva a conta da Ana)', async () => {
  const r = await rpcConta(U.ana, 'app_conta_antiga_unir', { p_token: bia.token });
  return { ok: r.ok === false && r.erro === 'ja_ligada' && (await ligacao('71991230002')).conta_antiga_id === null, detalhe: JSON.stringify(r) };
});
await caso('conta SEM celular mas com o MESMO e-mail do acesso rápido: também liga', async () => {
  const r = await rpcConta(U.cris, 'app_conta_antiga_unir', { p_token: cris.token });
  return { ok: r.ok === true && (await ligacao('71991230005')).conta_antiga_id === U.cris, detalhe: JSON.stringify(r) };
});
await caso('sem sessão da conta antiga (só o PIN): não faz nada (a conta não existe para o servidor)', async () => {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claims', '', false)`);
  await db.exec('set role authenticated');
  let msg = '';
  try { const r = (await q(`select public.app_conta_antiga_unir(p_token => $1) r`, [bia.token]))[0].r; msg = JSON.stringify(r); } finally { await db.exec('reset role'); }
  return { ok: /sem_conta/.test(msg) && (await ligacao('71991230002')).conta_antiga_id === null, detalhe: msg };
});
await caso('a migração normal (conta antiga cria o PIN) também traz as conversas da conta', async () => {
  const r = await rpcConta(U.dora, 'app_conta_antiga_migrar', { p_pin: '2580', p_telefone: '71991230004', p_nome: 'Dora Sem Pin Teste', p_nascimento: '1980-02-02', p_aparelho: 'teste' });
  const cs = await conversasDe('71991230004');
  return { ok: r.ok === true && cs.length === 1 && cs[0].conversa_id === cd && cs[0].visto_sig !== null, detalhe: JSON.stringify(r).slice(0, 160) };
});

const ruins = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - ruins} de ${resultados.length} passaram`);
process.exit(ruins ? 1 : 0);
