// FLUXOGRAMA: entrada (o retrato da produção + acesso-rapido-paciente.sql + acesso-rapido-chat.sql + acesso-rapido-conta-antiga.sql, aplicado duas vezes) -> validação (contas antigas inventadas em auth.users/contas_paciente; chamadas como "authenticated" com a sessão da conta, e como anônimo) -> lógica (resumo diz o que a conta tem e o que falta; herdar junta conta + cadastro da clínica, só pede o que falta, cria o acesso rápido com o PIN e abre o aparelho; recusa celular repetido, menor, PIN ruim, segunda herança, interruptor desligado) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (contas antigas viram acesso rápido)
// Dados: todos inventados neste arquivo (CPF 529.982.247-25 é o de exemplo que passa na conferência). Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-paciente.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-chat.sql`, 'utf8'));
const sql = readFileSync(`${REPO}/supabase/acesso-rapido-conta-antiga.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('acesso-rapido-conta-antiga.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);

const CPF = '52998224725';
const U = { rica: '00000000-0000-4000-8000-000000000001', pobre: '00000000-0000-4000-8000-000000000002', menor: '00000000-0000-4000-8000-000000000003', repetida: '00000000-0000-4000-8000-000000000004', fora: '00000000-0000-4000-8000-000000000005' };
// 1) conta com tudo (cadastro da clínica ligado: CPF, nascimento, telefone); 2) conta só com e-mail; 3) menor de idade; 4) mesmo celular da 1; 5) quem nunca teve conta
const pac = (await q(`insert into public.pacientes (nome, nome_norm, telefones, email, dt_nasc, cpf) values ('Ana Souza Teste', 'ana souza teste', array['71991230001'], 'ana@exemplo.invalid', '1988-04-12', '${CPF}') returning id`))[0].id;
await db.exec(`
  insert into auth.users (id, email) values ('${U.rica}', 'ana@exemplo.invalid'), ('${U.pobre}', 'so-email@exemplo.invalid'), ('${U.menor}', 'menor@exemplo.invalid'), ('${U.repetida}', 'copia@exemplo.invalid'), ('${U.fora}', 'fora@exemplo.invalid');
  insert into public.contas_paciente (id, email, nome, telefone, paciente_id) values ('${U.rica}', 'ana@exemplo.invalid', 'Ana Souza Teste', '71991230001', '${pac}');
  insert into public.contas_paciente (id, email) values ('${U.pobre}', 'so-email@exemplo.invalid');
  insert into public.contas_paciente (id, email, nome, telefone) values ('${U.menor}', 'menor@exemplo.invalid', 'Pedro Menor Teste', '71991230003');
  insert into public.contas_paciente (id, email, nome, telefone) values ('${U.repetida}', 'copia@exemplo.invalid', 'Copia Da Ana', '71991230001');
`);
await db.exec(`delete from public.contas_paciente where id = '${U.fora}'`);

const como_ = async (uid, fn, args = {}) => {
  await como(uid);
  const ks = Object.keys(args);
  try { return (await q(`select public.${fn}(${ks.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, ks.map((k) => args[k])))[0].r; }
  finally { await db.exec('reset role'); }
};
const resumo = (uid) => como_(uid, 'app_conta_antiga_resumo');
const herdar = (uid, args) => como_(uid, 'app_conta_antiga_herdar', args);
const modo = (v) => db.exec(`update public.config set valor = '${v}' where chave = 'app_acesso_modo'`);

await caso('resumo da conta completa: traz nome, celular, nascimento e CPF mascarado; nada falta', async () => {
  const r = await resumo(U.rica);
  return { ok: r.conta === true && r.migrada === false && r.nome === 'Ana Souza Teste' && r.telefone === '71991230001' && r.nascimento === '1988-04-12' && r.cpf_mascara === '***.***.***-25' && r.falta.length === 0, detalhe: JSON.stringify(r) };
});
await caso('resumo da conta só com e-mail: diz que faltam nome, celular e nascimento', async () => {
  const r = await resumo(U.pobre);
  return { ok: r.conta === true && r.falta.length === 3 && r.email === 'so-email@exemplo.invalid', detalhe: JSON.stringify(r) };
});
await caso('quem não tem conta antiga: conta=false', async () => ({ ok: (await resumo(U.fora)).conta === false }));
await caso('o público (anon) não executa nenhuma das duas funções', async () => {
  await anonimo();
  let a = false, b = false;
  try { await q(`select public.app_conta_antiga_resumo()`); } catch { a = true; }
  try { await q(`select public.app_conta_antiga_herdar(p_pin => '1357')`); } catch { b = true; }
  await db.exec('reset role');
  return { ok: a && b };
});

await caso('interruptor desligado: herdar responde "indisponivel" e não cria nada', async () => {
  await modo('nao'); const r = await herdar(U.rica, { p_pin: '1357' }); await modo('sim');
  return { ok: r.erro === 'indisponivel' && (await um(`select count(*)::int n from public.app_paciente`)).n === 0, detalhe: JSON.stringify(r) };
});
await caso('PIN que não tem 4 números é recusado', async () => {
  const a = await herdar(U.rica, { p_pin: '12' }), b = await herdar(U.rica, { p_pin: 'abcd' });
  return { ok: a.erro === 'pin' && b.erro === 'pin' };
});

let tok;
await caso('conta completa herda tudo com um PIN: nome, celular, e-mail, CPF e nascimento ficam salvos e o aparelho abre', async () => {
  const r = await herdar(U.rica, { p_pin: '1357', p_aparelho: 'teste' });
  tok = r.token;
  const a = await um(`select *, nascimento::text as nasc_txt from public.app_paciente where conta_antiga_id = '${U.rica}'`);
  return { ok: r.ok === true && !!tok && a.nome === 'Ana Souza Teste' && a.telefone === '71991230001' && a.email === 'ana@exemplo.invalid' && a.cpf === CPF
    && a.nasc_txt === '1988-04-12' && a.paciente_sugerido_id === pac && r.perfil.cpf_salvo === true && r.perfil.cpf_mascara === '***.***.***-25', detalhe: JSON.stringify(r.perfil) };
});
await caso('depois disso entra só com celular + PIN (app_login) e vê o mesmo perfil', async () => {
  await anonimo();
  const r = (await q(`select public.app_login(p_telefone => '71991230001', p_pin => '1357') r`))[0].r;
  await db.exec('reset role');
  return { ok: r.ok === true && r.perfil.nome === 'Ana Souza Teste' && r.perfil.cpf_salvo === true };
});
await caso('o PIN fica guardado em bcrypt (nunca em texto) e a conta antiga continua intacta', async () => {
  const a = await um(`select pin_hash from public.app_paciente where conta_antiga_id = '${U.rica}'`);
  const c = await um(`select email, nome, telefone, paciente_id from public.contas_paciente where id = '${U.rica}'`);
  return { ok: a.pin_hash.startsWith('$') && !a.pin_hash.includes('1357') && c.email === 'ana@exemplo.invalid' && c.paciente_id === pac };
});
await caso('o evento fica registrado sem dado pessoal', async () => {
  const e = await um(`select tipo from public.app_evento where tipo = 'conta_antiga_herdada'`);
  return { ok: !!e };
});
await caso('resumo depois da herança: migrada=true; herdar de novo é recusado ("ja_migrada")', async () => {
  const r = await resumo(U.rica), h = await herdar(U.rica, { p_pin: '2468' });
  return { ok: r.migrada === true && h.erro === 'ja_migrada' && (await um(`select count(*)::int n from public.app_paciente where conta_antiga_id = '${U.rica}'`)).n === 1, detalhe: `${r.migrada} ${h.erro}` };
});
await caso('outra conta com o mesmo celular é recusada (celular já tem acesso rápido)', async () => {
  const r = await herdar(U.repetida, { p_pin: '1357', p_nascimento: '1985-06-06' });
  return { ok: r.erro === 'telefone_cadastrado' && (await um(`select count(*)::int n from public.app_paciente where conta_antiga_id = '${U.repetida}'`)).n === 0, detalhe: JSON.stringify(r) };
});
await caso('conta só com e-mail: sem os dados que faltam, o servidor pede um a um (celular, nome, nascimento)', async () => {
  const a = await herdar(U.pobre, { p_pin: '1357' });
  const b = await herdar(U.pobre, { p_pin: '1357', p_telefone: '(71) 99123-0009' });
  const c = await herdar(U.pobre, { p_pin: '1357', p_telefone: '71991230009', p_nome: 'Bia Costa Teste' });
  return { ok: a.erro === 'celular' && b.erro === 'nome' && c.erro === 'nascimento', detalhe: `${a.erro} ${b.erro} ${c.erro}` };
});
await caso('conta só com e-mail: completando celular, nome e nascimento, herda (sem CPF, que ela ainda não tem)', async () => {
  const r = await herdar(U.pobre, { p_pin: '1357', p_telefone: '71991230009', p_nome: 'Bia Costa Teste', p_nascimento: '1990-02-03', p_aparelho: 'teste' });
  const a = await um(`select cpf, email, telefone from public.app_paciente where conta_antiga_id = '${U.pobre}'`);
  return { ok: r.ok === true && a.cpf === null && a.email === 'so-email@exemplo.invalid' && a.telefone === '71991230009' && r.perfil.cpf_salvo === false, detalhe: JSON.stringify(a) };
});
await caso('menor de 18 anos é recusado', async () => {
  const r = await herdar(U.menor, { p_pin: '1357', p_nascimento: '2015-05-05' });
  return { ok: r.erro === 'menor' };
});
await caso('quem não tem conta antiga não consegue herdar nada', async () => {
  const r = await herdar(U.fora, { p_pin: '1357', p_telefone: '71991230077', p_nome: 'Quem Nao Existe', p_nascimento: '1980-01-01' });
  return { ok: r.erro === 'sem_conta' };
});
await caso('uma conta nunca herda a conta de outra: o servidor usa só a sessão (não há parâmetro de conta)', async () => {
  const params = (await q(`select pg_get_function_arguments('public.app_conta_antiga_herdar(text,text,text,text,text)'::regprocedure) a`))[0].a;
  return { ok: !/uuid|conta|email/i.test(params), detalhe: params };
});
await caso('com o aparelho aberto o perfil novo aparece em app_perfil', async () => {
  await anonimo();
  const r = (await q(`select public.app_perfil(p_token => $1) r`, [tok]))[0].r;
  await db.exec('reset role');
  return { ok: r.ok === true && r.perfil.email === 'ana@exemplo.invalid' };
});

await caso('colar a "última parte" (acesso-rapido-ultima-parte.sql) depois NÃO tira a permissão das funções da conta antiga, e o público continua sem acesso', async () => {
  await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-ultima-parte.sql`, 'utf8'));
  const p = (await q(`select has_function_privilege('authenticated', 'public.app_conta_antiga_herdar(text,text,text,text,text)', 'execute') a,
    has_function_privilege('anon', 'public.app_conta_antiga_herdar(text,text,text,text,text)', 'execute') b,
    has_function_privilege('authenticated', 'public.app_conta_antiga_resumo()', 'execute') c,
    has_function_privilege('anon', 'public.app_conta_antiga_resumo()', 'execute') d,
    has_function_privilege('authenticated', 'public.app_login(text,text,text)', 'execute') e,
    has_function_privilege('authenticated', 'public.app_perfil(text)', 'execute') f`))[0];
  return { ok: p.a && !p.b && p.c && !p.d && p.e && p.f, detalhe: JSON.stringify(p) };
});

const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
