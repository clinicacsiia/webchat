// FLUXOGRAMA: entrada (o retrato da produção + supabase/acesso-filho-cpf-opcional.sql aplicada duas vezes; dados INVENTADOS) -> validação (cadastro com e sem CPF do filho; CPF do filho errado; CPF do responsável) -> lógica (app_pin_criar e app_pendencias_lista) -> saída (PASS/FAIL)
// Versão 1.0 — 23/11/2026 / Mudança: Implementação inicial (CPF do filho opcional no cadastro do acesso rápido)
// Dados: todos inventados (CPF 529.982.247-25 e 111.444.777-35 passam na conferência). Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo } = ajudantes(db);
const sql = readFileSync(`${REPO}/supabase/acesso-filho-cpf-opcional.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('acesso-filho-cpf-opcional.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.exec(`insert into public.config (chave, valor) values ('app_acesso_modo', 'sim') on conflict (chave) do update set valor = 'sim'`);
await db.exec(`insert into public.config (chave, valor) values ('app_codigo_email', 'nao') on conflict (chave) do update set valor = 'nao'`);

const C1 = '52998224725', C2 = '11144477735';
const rpc = async (nome, args) => {
  const ks = Object.keys(args); await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${args[k] !== null && typeof args[k] === 'object' ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
const criar = (o) => rpc('app_pin_criar', Object.assign({ p_pin: '1357', p_aparelho: 'Teste' }, o));
const linha = (tel) => um(`select * from public.app_paciente where telefone = $1`, [tel]);
const filhos = (id) => q(`select nome, cpf from public.app_filho where responsavel_id = $1 and removido_em is null order by nome`, [id]);

await caso('cadastro com filho SEM CPF cria o PIN e o filho fica com CPF em branco', async () => {
  const r = await criar({ p_telefone: '71991230101', p_nome: 'Ana Souza Teste', p_nascimento: '1988-04-12', p_cpf: C1, p_filhos: [{ nome: 'Leo Souza Teste', nascimento: '2019-08-30' }] });
  const l = await linha('71991230101'), f = l ? await filhos(l.id) : [];
  return { ok: r.ok === true && l && l.cpf === C1 && f.length === 1 && f[0].cpf === null, detalhe: JSON.stringify([r.ok, r.erro, f]) };
});
await caso('dois filhos: um com CPF e outro sem; cada CPF vai para o filho certo', async () => {
  const r = await criar({ p_telefone: '71991230102', p_nome: 'Bia Costa Teste', p_nascimento: '1990-02-03', p_cpf: C1,
    p_filhos: [{ nome: 'Caio Costa Teste', nascimento: '2018-01-01' }, { nome: 'Davi Costa Teste', nascimento: '2020-02-02', cpf: C2 }] });
  const l = await linha('71991230102'), f = l ? await filhos(l.id) : [];
  const caio = f.find((x) => x.nome.startsWith('Caio')), davi = f.find((x) => x.nome.startsWith('Davi'));
  return { ok: r.ok === true && caio && caio.cpf === null && davi && davi.cpf === C2, detalhe: JSON.stringify([r.ok, r.erro, f]) };
});
await caso('CPF do filho digitado errado continua recusado, sem criar nada (tudo ou nada)', async () => {
  const r = await criar({ p_telefone: '71991230103', p_nome: 'Eva Dias Teste', p_nascimento: '1980-03-03', p_cpf: C1, p_filhos: [{ nome: 'Tomas Dias Teste', nascimento: '2017-07-07', cpf: '12345678900' }] });
  return { ok: r.ok === false && r.erro === 'filho_cpf' && (await linha('71991230103')) === undefined, detalhe: JSON.stringify([r.ok, r.erro]) };
});
await caso('CPF do RESPONSÁVEL continua obrigatório', async () => {
  const r = await criar({ p_telefone: '71991230104', p_nome: 'Fabi Lima Teste', p_nascimento: '1985-05-05', p_filhos: [] });
  return { ok: r.ok === false && r.erro === 'cpf_falta' && (await linha('71991230104')) === undefined, detalhe: JSON.stringify([r.ok, r.erro]) };
});
await caso('a pendência do CPF do filho é OPCIONAL (não trava a entrada); a do responsável segue obrigatória', async () => {
  const l = await linha('71991230101');
  await db.exec(`update public.app_paciente set cpf = null where id = '${l.id}'`);
  const lista = (await q(`select public.app_pendencias_lista('${l.id}'::uuid) r`))[0].r;
  const eu = lista.find((x) => x.pessoa === 'eu' && x.campo === 'cpf'), fi = lista.find((x) => x.pessoa !== 'eu' && x.campo === 'cpf');
  return { ok: eu && eu.opcional === false && fi && fi.opcional === true && /opcional/.test(fi.pergunta), detalhe: JSON.stringify(lista.map((x) => [x.pessoa === 'eu' ? 'eu' : 'filho', x.campo, x.opcional])) };
});

console.log(`\n${resultados.filter(Boolean).length}/${resultados.length} casos passaram`);
process.exit(resultados.every(Boolean) ? 0 : 1);
