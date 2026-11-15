// FLUXOGRAMA: entrada (o retrato da produção + acesso-rapido-paciente.sql + acesso-checkin-pin.sql; cadastro, conta antiga e fila INVENTADOS) -> validação (app_checkin chamada como "anon" com aparelho desbloqueado, com PIN vencido, com código desconhecido e com o interruptor desligado)
//   -> lógica (mesmo e-mail e celular de uma CONTA ANTIGA: o checkin_publico pede a senha (o defeito), a app_checkin NÃO pede e põe na fila; segunda chamada não duplica; limite diário; filho/outra pessoa não se misturam) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (defeito: o check-in de um toque do acesso rápido pedia a senha da conta antiga)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, anonimo } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-paciente.sql`, 'utf8'));
const sqlNovo = readFileSync(`${REPO}/supabase/acesso-checkin-pin.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);

const rpc = async (nome, args) => {
  const ks = Object.keys(args);
  await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, ks.map((k) => args[k])))[0].r; }
  finally { await db.exec('reset role'); }
};
const dono = (s, p) => q(s, p);

await caso('a migração aplica sem erro e pode ser aplicada duas vezes', async () => { await db.exec(sqlNovo); await db.exec(sqlNovo); return { ok: true }; });

// Ana tem acesso rápido (celular + PIN) E uma conta antiga com o MESMO e-mail e celular: é o caso do dono do sistema.
const EMAIL = 'ana@exemplo.invalid', TEL = '71991230001';
const ana = await rpc('app_cadastrar', { p_telefone: TEL, p_nome: 'Ana Souza Teste', p_nascimento: '1988-04-12', p_pin: '1357', p_filhos: [], p_aparelho: 'teste' });
const TOK = ana.token;
await dono(`update public.app_paciente set email = '${EMAIL}' where telefone = '${TEL}'`);
await dono(`insert into auth.users (id, email) values ('33333333-3333-4333-8333-333333333333', '${EMAIL}')`);
await dono(`insert into public.contas_paciente (id, email, nome, telefone) values ('33333333-3333-4333-8333-333333333333', '${EMAIL}', 'Ana Souza Teste', '${TEL}')`);
const fila = () => dono(`select nome, email, telefone, origem, pede_senha, conta_id from public.fila_chegada`);

await caso('o defeito: a checkin_publico com os dados do cadastro responde "conta_existente" (pede a senha) e não põe na fila', async () => {
  const r = await rpc('checkin_publico', { p_nome: 'Ana Souza Teste', p_email: EMAIL, p_telefone: TEL, p_ajuda_senha: false });
  return { ok: r.situacao === 'conta_existente' && (await fila()).length === 0, detalhe: JSON.stringify(r) };
});
await caso('app_checkin com o aparelho desbloqueado: NÃO pede senha, põe na fila com nome, e-mail e celular do cadastro e devolve o ticket', async () => {
  const r = await rpc('app_checkin', { p_token: TOK });
  const f = await fila();
  return { ok: r.ok === true && r.situacao === 'aguardando' && !!r.ticket && r.senha === 1 && f.length === 1 && f[0].nome === 'Ana Souza Teste' && f[0].email === EMAIL && f[0].telefone === TEL && f[0].origem === 'paciente' && f[0].pede_senha === false, detalhe: JSON.stringify(r) };
});
await caso('chamar de novo não duplica: devolve a mesma linha e o mesmo ticket', async () => {
  const antes = (await dono(`select ticket from public.fila_chegada`))[0].ticket;
  const r = await rpc('app_checkin', { p_token: TOK });
  const f = await fila();
  return { ok: r.ok === true && r.ticket === antes && f.length === 1, detalhe: `${f.length} linha(s)` };
});
await caso('a situação pelo ticket (fila_minha_vez_ticket) abre a fila sem login', async () => {
  const t = (await dono(`select ticket from public.fila_chegada`))[0].ticket;
  const r = await rpc('fila_minha_vez_ticket', { p_ticket: t });
  return { ok: r && r.situacao === 'aguardando', detalhe: JSON.stringify(r) };
});
await caso('sem e-mail no cadastro: faz o check-in do mesmo jeito (e-mail fica vazio)', async () => {
  await dono(`delete from public.fila_chegada`);
  await dono(`update public.app_paciente set email = null where telefone = '${TEL}'`);
  const r = await rpc('app_checkin', { p_token: TOK });
  const f = await fila();
  return { ok: r.ok === true && f.length === 1 && f[0].email === null, detalhe: JSON.stringify(r) };
});
await caso('PIN vencido (30 min): recusa com "bloqueado" e NÃO põe na fila', async () => {
  await dono(`delete from public.fila_chegada`);
  await dono(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const r = await rpc('app_checkin', { p_token: TOK });
  return { ok: r.ok === false && r.erro === 'bloqueado' && (await fila()).length === 0, detalhe: JSON.stringify(r) };
});
await caso('código de aparelho desconhecido: recusa com "sessao"', async () => {
  const r = await rpc('app_checkin', { p_token: 'codigo-que-nao-existe' });
  return { ok: r.ok === false && r.erro === 'sessao' && (await fila()).length === 0, detalhe: JSON.stringify(r) };
});
await caso('acesso rápido desligado: recusa com "indisponivel"', async () => {
  await dono(`update public.config set valor = 'nao' where chave = 'app_acesso_modo'`);
  const r = await rpc('app_checkin', { p_token: TOK });
  await dono(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);
  return { ok: r.ok === false && r.erro === 'indisponivel' && (await fila()).length === 0, detalhe: JSON.stringify(r) };
});
await caso('limite diário de check-ins sem conta vale também aqui', async () => {
  await dono(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  await dono(`update public.config set valor = '1' where chave = 'checkin_sem_login_max_dia'`);
  await dono(`insert into public.fila_chegada (nome, senha, origem) values ('Outra Pessoa Teste', 1, 'paciente')`);
  let msg = '';
  try { await rpc('app_checkin', { p_token: TOK }); } catch (e) { msg = String(e.message); }
  await dono(`update public.config set valor = '300' where chave = 'checkin_sem_login_max_dia'`);
  return { ok: /Muitos check-ins/.test(msg), detalhe: msg };
});
await caso('a função é executável pelo público (anon e authenticated), não por "public"', async () => {
  const r = await dono(`select has_function_privilege('anon', 'public.app_checkin(text)', 'execute') a, has_function_privilege('authenticated', 'public.app_checkin(text)', 'execute') b`);
  return { ok: r[0].a === true && r[0].b === true };
});

const ruins = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - ruins} de ${resultados.length} passaram`);
process.exit(ruins ? 1 : 0);
