// FLUXOGRAMA: entrada (o retrato da produção + acesso rápido + conta antiga + pendências + filhos + painel; equipe, contas e pacientes INVENTADOS) -> validação (admin e atendente leem; marketing, paciente logado e público não) -> lógica (contadores e lista de contas antigas sem PIN; as ações dos botões: confirmar solicitação, marcar cadastro como conferido) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (botão Pendências do painel)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
for (const f of ['acesso-rapido-paciente', 'acesso-rapido-chat', 'acesso-rapido-conta-antiga', 'acesso-rapido-pendencias', 'acesso-rapido-filhos']) await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8'));
const sql = readFileSync(`${REPO}/supabase/acesso-rapido-painel.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('acesso-rapido-painel.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);

const ADM = '00000000-0000-4000-8000-0000000000c1', ATE = '00000000-0000-4000-8000-0000000000c2', MKT = '00000000-0000-4000-8000-0000000000c3', PAC = '00000000-0000-4000-8000-0000000000c4';
const CA = '00000000-0000-4000-8000-0000000000d1', CB = '00000000-0000-4000-8000-0000000000d2';
await db.exec(`insert into auth.users (id, email) values ('${ADM}', 'adm@x.invalid'), ('${ATE}', 'ate@x.invalid'), ('${MKT}', 'mkt@x.invalid'), ('${PAC}', 'pac@x.invalid'), ('${CA}', 'ca@x.invalid'), ('${CB}', 'cb@x.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Adm Teste', 'adm@x.invalid', 'admin', true), ('${ATE}', 'Ate Teste', 'ate@x.invalid', 'atendente', true), ('${MKT}', 'Mkt Teste', 'mkt@x.invalid', 'marketing', true)
    on conflict (id) do update set papel = excluded.papel, ativo = true;
  insert into public.contas_paciente (id, email, nome, telefone) values ('${CA}', 'ca@x.invalid', 'Conta Antiga Um', '71991230061'), ('${CB}', 'cb@x.invalid', 'Conta Antiga Dois', '71991230062');`);
const rpcAnon = async (nome, args) => { const ks = Object.keys(args); await anonimo(); try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, ks.map((k) => args[k])))[0].r; } finally { await db.exec('reset role'); } };
const equipe = async (uid, fn, args = []) => { await como(uid); try { return (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args))[0].r; } catch (e) { return { erro: String(e.message) }; } finally { await db.exec('reset role'); } };

// uma pessoa no acesso rápido, com solicitação de marcação e CPF que gera dúvida
const ana = await rpcAnon('app_cadastrar', { p_telefone: '71991230001', p_nome: 'Ana Souza Teste', p_nascimento: '1988-04-12', p_pin: '1357', p_aparelho: 't' });
await db.exec(`insert into public.pacientes (nome, nome_norm, telefones, dt_nasc, cpf) values ('Bia Costa Teste', 'bia costa teste', array['71991230002'], '1990-02-03', '529.982.247-25')`);
await rpcAnon('app_pendencia_responder', { p_token: ana.token, p_pessoa: 'eu', p_campo: 'cpf', p_valor: '52998224725' });   // CPF de outra pessoa da clínica -> marca para a equipe
const marc = await rpcAnon('app_marcar', { p_token: ana.token, p_pessoas: JSON.stringify(['eu']), p_exame: 'Ultrassom', p_data: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), p_turno: 'Manhã' });

await caso('contadores: 1 solicitação, 1 revisão, 2 contas antigas sem PIN, 0 sem CPF, 1 acesso rápido (admin e atendente)', async () => {
  const a = await equipe(ADM, 'painel_app_pendencias_resumo'), b = await equipe(ATE, 'painel_app_pendencias_resumo');
  const ok = (r) => r.solicitacoes === 1 && r.revisoes === 1 && r.contas_antigas === 2 && r.sem_cpf === 0 && r.acesso_rapido === 1;
  return { ok: marc.ok === true && ok(a) && ok(b), detalhe: JSON.stringify(a) };
});
await caso('marketing, paciente logado e público NÃO leem contadores nem a lista de contas antigas', async () => {
  const m = await equipe(MKT, 'painel_app_pendencias_resumo'), p = await equipe(PAC, 'painel_app_contas_antigas');
  await anonimo(); let negou = 0;
  for (const f of ['painel_app_pendencias_resumo()', 'painel_app_contas_antigas()']) { try { await q(`select public.${f}`); } catch { negou++; } }
  await db.exec('reset role');
  return { ok: /Só a equipe/.test(m.erro || '') && /Só a equipe/.test(p.erro || '') && negou === 2 };
});
await caso('lista das contas antigas sem PIN traz nome, celular, e-mail e filhos no histórico (sem CPF)', async () => {
  const l = await equipe(ATE, 'painel_app_contas_antigas'); const txt = JSON.stringify(l);
  return { ok: l.length === 2 && l[0].nome === 'Conta Antiga Um' && l[0].celular === '71991230061' && l[0].email === 'ca@x.invalid' && l[0].filhos_no_historico === 0 && !/cpf/i.test(txt), detalhe: txt.slice(0, 120) };
});
await caso('quem migra sai da lista e da contagem das contas antigas', async () => {
  await como(CA); const r = (await q(`select public.app_conta_antiga_migrar(p_pin => '2468', p_nascimento => '1980-01-01', p_aparelho => 't') r`))[0].r; await db.exec('reset role');
  const res = await equipe(ADM, 'painel_app_pendencias_resumo'), l = await equipe(ADM, 'painel_app_contas_antigas');
  return { ok: r.ok === true && res.contas_antigas === 1 && l.length === 1 && l[0].nome === 'Conta Antiga Dois' && res.acesso_rapido === 2, detalhe: JSON.stringify(res) };
});
await caso('botão "Confirmar": a solicitação muda de situação e o contador cai; o paciente passa a ver "confirmada"', async () => {
  const lista = await equipe(ATE, 'painel_app_solicitacoes', ['solicitada']);
  const n = await equipe(ATE, 'painel_app_solicitacao_status', [lista[0].grupo, 'confirmada']);
  const res = await equipe(ATE, 'painel_app_pendencias_resumo'), conf = await equipe(ATE, 'painel_app_solicitacoes', ['confirmada']);
  const perfil = await rpcAnon('app_perfil', { p_token: ana.token });
  return { ok: lista.length === 1 && lista[0].responsavel === 'Ana Souza Teste' && n >= 1 && res.solicitacoes === 0 && conf.length === 1 && perfil.perfil.marcacoes[0].status === 'confirmada', detalhe: `${n} ${JSON.stringify(res)}` };
});
await caso('botão "Marcar como conferido": a revisão some da lista e do contador, sem CPF inteiro', async () => {
  const l = await equipe(ATE, 'painel_app_revisoes'); const txt = JSON.stringify(l);
  const n = await equipe(ATE, 'painel_app_revisao_resolver', [l[0].id]);
  const res = await equipe(ATE, 'painel_app_pendencias_resumo'), depois = await equipe(ATE, 'painel_app_revisoes');
  return { ok: l.length === 1 && l[0].motivo === 'cpf_com_outro_celular' && !txt.includes('52998224725') && n === 1 && res.revisoes === 0 && depois.length === 0, detalhe: l[0] && l[0].motivo };
});
await caso('pessoa sem CPF entra na contagem "sem_cpf"', async () => {
  await rpcAnon('app_cadastrar', { p_telefone: '71991230003', p_nome: 'Cris Alves Teste', p_nascimento: '1992-03-04', p_pin: '1357', p_aparelho: 't' });
  const res = await equipe(ADM, 'painel_app_pendencias_resumo'); return { ok: res.sem_cpf >= 1, detalhe: String(res.sem_cpf) };
});
await caso('colar a "última parte" depois mantém as permissões do painel (equipe sim, público não)', async () => {
  await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-ultima-parte.sql`, 'utf8'));
  const p = (await q(`select has_function_privilege('authenticated','public.painel_app_pendencias_resumo()','execute') a, has_function_privilege('anon','public.painel_app_pendencias_resumo()','execute') b,
    has_function_privilege('authenticated','public.painel_app_contas_antigas()','execute') c, has_function_privilege('anon','public.painel_app_contas_antigas()','execute') d`))[0];
  return { ok: p.a && !p.b && p.c && !p.d, detalhe: JSON.stringify(p) };
});

const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
