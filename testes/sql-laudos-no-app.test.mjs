// FLUXOGRAMA: entrada (o retrato da produção + supabase/laudos-no-app.sql; pacientes, filhos e marcações INVENTADOS) -> validação (aparelho com e sem PIN, token errado, outro paciente, CPF trocado, interruptor desligado, permissões)
//   -> lógica (conferência da pessoa, lista de marcações, estado do laudo, "em revisão" quando a equipe retira, bloqueio do download) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (laudos no aplicativo). A Edge Function é provada em supabase/functions/app-laudos/laudos.test.ts.
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, anonimo } = ajudantes(db);
const sql = readFileSync(`${REPO}/supabase/laudos-no-app.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('laudos-no-app.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.exec(`insert into public.config (chave, valor) values ('app_acesso_modo', 'sim') on conflict (chave) do update set valor = 'sim'`);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste') on conflict (name) do nothing`);

const rpcAnon = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
const svc = async (nome, args = []) => (await q(`select public.${nome}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args))[0].r;
const svcJ = async (nome, pre, json) => (await q(`select public.${nome}(${pre.map((_, i) => `$${i + 1}`).join(', ')}${pre.length ? ', ' : ''}$${pre.length + 1}::jsonb) r`, [...pre, JSON.stringify(json)]))[0].r;
const CPF_ANA = '52998224725', CPF_LEO = '11144477735', CPF_BIA = '39053344705', CPF_NOVO = '16899535009';
const NASC_ANA = '1988-04-12', NASC_LEO = '2019-08-30';
const cad = (tel, nome, nasc, filhos = []) => rpcAnon('app_cadastrar', { p_telefone: tel, p_nome: nome, p_nascimento: nasc, p_pin: '1357', p_filhos: filhos, p_aparelho: 'teste' });
const ana = await cad('71991230001', 'Ana Souza Teste', NASC_ANA, [{ nome: 'Leo Souza Teste', nascimento: NASC_LEO }]);
const bia = await cad('71991230002', 'Bia Amiga Teste', '1990-01-01');
const TOK = ana.token, TOK_BIA = bia.token;
const PAC = (await q(`select id from public.app_paciente where telefone = '71991230001'`))[0].id;
const PAC_BIA = (await q(`select id from public.app_paciente where telefone = '71991230002'`))[0].id;
await q(`update public.app_paciente set cpf = $1 where id = $2`, [CPF_ANA, PAC]);
await q(`update public.app_paciente set cpf = $1 where id = $2`, [CPF_BIA, PAC_BIA]);
await q(`update public.app_filho set cpf = $1 where responsavel_id = $2`, [CPF_LEO, PAC]);
const LEO = (await q(`select id from public.app_filho where responsavel_id = $1`, [PAC]))[0].id;
const dia = (n) => await_dia(n);
function await_dia(n) { const d = new Date(Date.now() + n * 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const lista = (pac = PAC) => svc('app_laudos_lista', [pac]);
const ctx = (tok = TOK, renova = false) => svc('app_laudos_contexto', [tok, renova]);
const conferir = (pessoa = 'eu', kid = 'P100', pac = PAC) => svc('app_laudos_pessoa_gravar', [pac, pessoa, 'confere', kid]);
const itens = (pessoa, lista_, pac = PAC) => svcJ('app_laudos_itens_gravar', [pac, pessoa], lista_);
const estado = (id, pronto, pac = PAC) => svc('app_laudos_estado', [pac, id, pronto]);
const linha = async (id) => (await q(`select estado, disponivel_em is not null as disp, retirado_em is not null as ret, checado_em is not null as chk from public.app_laudo where marcacao_id = $1`, [id]))[0];

// ---------------------------------------------------------------- contexto (aparelho, PIN, pessoas)
await caso('contexto: aparelho com PIN devolve titular e filho, com CPF (só para o servidor) e nada conferido ainda', async () => {
  const c = await ctx();
  const eu = c.pessoas?.[0], leo = c.pessoas?.[1];
  return { ok: c.ok === true && c.paciente_id === PAC && c.pessoas.length === 2 && eu.chave === 'eu' && eu.cpf === CPF_ANA && leo.chave === LEO && leo.cpf === CPF_LEO && eu.situacao === 'pendente' && eu.klingo_id === null, detalhe: JSON.stringify(c).slice(0, 200) };
});
await caso('contexto: token inventado = "sessao"; PIN vencido = "bloqueado" (também ao recarregar sem renovar)', async () => {
  const a = await ctx('token-que-nao-existe');
  await q(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const b = await ctx(TOK, false), c = await ctx(TOK, true);
  await q(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  return { ok: a.erro === 'sessao' && b.erro === 'bloqueado' && c.erro === 'bloqueado', detalhe: [a.erro, b.erro, c.erro].join(',') };
});
await caso('permissão: anon NÃO executa nenhuma das funções dos laudos (só o servidor)', async () => {
  const nomes = [['app_laudos_contexto', ["'x'", 'false']], ['app_laudos_pode', ["'x'", "'1'"]], ['app_laudos_lista', [`'${PAC}'::uuid`]], ['app_laudos_estado', [`'${PAC}'::uuid`, "'1'", 'true']],
    ['app_laudos_a_checar', [`'${PAC}'::uuid`, '3']], ['app_laudos_pessoa_gravar', [`'${PAC}'::uuid`, "'eu'", "'confere'", "'P1'"]], ['app_laudos_itens_gravar', [`'${PAC}'::uuid`, "'eu'", "'[]'::jsonb"]], ['app_laudos_pessoas', [`'${PAC}'::uuid`]]];
  const barrou = [];
  for (const [n, a] of nomes) { await anonimo(); try { await db.query(`select public.${n}(${a.join(', ')})`); } catch (e) { if (/permission denied/i.test(e.message)) barrou.push(n); } finally { await db.exec('reset role'); } }
  return { ok: barrou.length === nomes.length, detalhe: `${barrou.length}/${nomes.length} barradas` };
});

// ---------------------------------------------------------------- conferência e lista
const ITENS = [
  { id: '501', procedimento: 'RM JOELHO DIREITO', data: dia(-5), unidade: 'Centro' },
  { id: '502', procedimento: 'US ABDOME TOTAL', data: dia(-3), unidade: 'Centro' },
  { id: '503', procedimento: 'CONSULTA NEUROLOGIA', data: dia(-2), unidade: 'Centro' },
  { id: '504', procedimento: 'RX TORAX', data: dia(-200), unidade: 'Centro' },
  { id: 'x9', procedimento: 'id inválido', data: dia(-1), unidade: 'Centro' },
];
await caso('itens_gravar recusa pessoa que a clínica ainda não confirmou', async () => ({ ok: (await itens('eu', ITENS)) === false && (await lista()).itens.length === 0 }));
await caso('depois de conferida, as marcações entram (id inválido é ignorado) e a lista nunca traz CPF nem PDF', async () => {
  await conferir('eu', 'P100');
  const g = await itens('eu', ITENS);
  const l = await lista();
  const txt = JSON.stringify(l);
  return { ok: g === true && (await q(`select count(*)::int n from public.app_laudo`))[0].n === 4 && !txt.includes(CPF_ANA) && !/pdf|base64/i.test(txt) && l.pessoas[0].situacao === 'confere', detalhe: txt.slice(0, 160) };
});
await caso('lista: sem laudo ainda, só o recente e só o que não é consulta (a consulta e o exame de 200 dias atrás não aparecem)', async () => {
  const ids = (await lista()).itens.map((i) => i.id).sort();
  return { ok: ids.join(',') === '501,502', detalhe: ids.join(',') };
});
await caso('contexto devolve o id do Klingo e a hora da leitura depois da conferência (a tela não refaz o CPF a cada abertura)', async () => {
  const eu = (await ctx()).pessoas[0];
  return { ok: eu.klingo_id === 'P100' && eu.situacao === 'confere' && !!eu.voucher_em, detalhe: JSON.stringify({ k: eu.klingo_id, s: eu.situacao }) };
});
await caso('o filho é conferido à parte, com o CPF e o nascimento dele', async () => {
  await conferir(LEO, 'P200');
  await itens(LEO, [{ id: '601', procedimento: 'TC TORAX', data: dia(-1), unidade: 'Centro' }]);
  await estado('601', true);
  const l = await lista();
  const i601 = l.itens.find((i) => i.id === '601');
  return { ok: !!i601 && i601.eu === false && i601.pessoa === 'Leo Souza Teste' && i601.estado === 'disponivel', detalhe: JSON.stringify(i601) };
});

// ---------------------------------------------------------------- estado do laudo (disponível, retirado, liberado de novo)
await caso('a_checar: o que nunca foi conferido vem primeiro; depois de conferido, só volta depois de 15 min', async () => {
  const a = await svc('app_laudos_a_checar', [PAC, 6]);
  await estado('501', false); await estado('502', false);
  const b = await svc('app_laudos_a_checar', [PAC, 6]);
  await q(`update public.app_laudo set checado_em = now() - interval '16 minutes' where marcacao_id = '501'`);
  const c = await svc('app_laudos_a_checar', [PAC, 6]);
  return { ok: a.includes('501') && a.includes('502') && !b.includes('501') && c.includes('501'), detalhe: JSON.stringify([a, b, c]) };
});
await caso('Klingo diz pronto: o laudo fica "disponível" (e guarda quando)', async () => {
  await estado('501', true);
  const x = await linha('501');
  return { ok: x.estado === 'disponivel' && x.disp && !x.ret, detalhe: JSON.stringify(x) };
});
await caso('a equipe RETIRA o laudo para ajuste: disponível vira "em revisão" (retirado_em guardado); quem nunca esteve pronto continua "aguardando"', async () => {
  await estado('501', false); await estado('502', false);
  const a = await linha('501'), b = await linha('502');
  return { ok: a.estado === 'em_revisao' && a.ret && b.estado === 'aguardando' && !b.ret, detalhe: JSON.stringify([a, b]) };
});
await caso('em revisão continua na lista (o paciente vê o aviso) e volta a "disponível" quando a equipe libera de novo', async () => {
  const antes = (await lista()).itens.find((i) => i.id === '501');
  await estado('501', true);
  const x = await linha('501');
  return { ok: antes.estado === 'em_revisao' && x.estado === 'disponivel' && !x.ret, detalhe: antes.estado + ' -> ' + x.estado };
});

// ---------------------------------------------------------------- pode baixar
await caso('pode: aparelho com PIN e marcação da própria pessoa (titular e filho) = ok', async () => {
  const a = await svc('app_laudos_pode', [TOK, '501']), b = await svc('app_laudos_pode', [TOK, '601']);
  return { ok: a.ok === true && a.paciente_id === PAC && b.ok === true, detalhe: JSON.stringify([a.erro, b.erro]) };
});
await caso('pode: outro paciente NÃO baixa o laudo de Ana (nem sabendo o número da marcação)', async () => {
  const r = await svc('app_laudos_pode', [TOK_BIA, '501']);
  return { ok: r.ok === false && r.erro === 'sem_acesso', detalhe: JSON.stringify(r) };
});
await caso('pode: marcação que não existe, id malformado, token inventado e PIN vencido são recusados', async () => {
  const a = await svc('app_laudos_pode', [TOK, '999']), b = await svc('app_laudos_pode', [TOK, "501' or '1'='1"]), c = await svc('app_laudos_pode', ['token-que-nao-existe', '501']);
  await q(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const d = await svc('app_laudos_pode', [TOK, '501']);
  await q(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  return { ok: a.ok === false && b.ok === false && c.erro === 'sessao' && d.erro === 'bloqueado', detalhe: [a.erro, b.erro, c.erro, d.erro].join(',') };
});
await caso('pode: depois de 60 downloads na hora, para (quem tenta puxar tudo)', async () => {
  for (let i = 0; i < 60; i++) await svc('app_evento_gravar', [PAC, 'laudo_baixado']);
  const r = await svc('app_laudos_pode', [TOK, '501']);
  await q(`update public.app_evento set criado_em = now() - interval '2 hours' where tipo = 'laudo_baixado'`);
  const ok2 = await svc('app_laudos_pode', [TOK, '501']);
  return { ok: r.ok === false && r.erro === 'muitos' && ok2.ok === true, detalhe: r.erro + ' / ' + ok2.ok };
});

// ---------------------------------------------------------------- identidade muda, filho removido, desligar
await caso('CPF do titular trocado em Meus dados: a conferência antiga deixa de valer (some da lista, o id do Klingo some do contexto, não baixa)', async () => {
  await q(`update public.app_paciente set cpf = $1 where id = $2`, [CPF_NOVO, PAC]);
  const l = await lista(), c = (await ctx()).pessoas[0], p = await svc('app_laudos_pode', [TOK, '501']);
  const doFilho = l.itens.filter((i) => !i.eu).length;
  return { ok: l.itens.filter((i) => i.eu).length === 0 && doFilho === 1 && c.klingo_id === null && c.situacao === 'pendente' && p.ok === false, detalhe: JSON.stringify({ itens: l.itens.length, k: c.klingo_id, s: c.situacao, p: p.erro }) };
});
await caso('conferida de novo com o CPF novo, as linhas antigas NÃO voltam sozinhas: reiniciam como "aguardando" (outra identidade não herda estado de laudo)', async () => {
  await conferir('eu', 'P300');
  await itens('eu', [{ id: '501', procedimento: 'RM JOELHO DIREITO', data: dia(-5), unidade: 'Centro' }]);
  const x = await linha('501');
  return { ok: x.estado === 'aguardando' && !x.disp && !x.chk, detalhe: JSON.stringify(x) };
});
await caso('CPF desfeito: divergente/nao_encontrado apagam o id do Klingo; "travado" mantém o que já havia', async () => {
  await svc('app_laudos_pessoa_gravar', [PAC, 'eu', 'travado', null]);
  const a = (await ctx()).pessoas[0];
  await svc('app_laudos_pessoa_gravar', [PAC, 'eu', 'divergente', null]);
  const b = (await ctx()).pessoas[0], l = await lista();
  return { ok: a.situacao === 'travado' && a.klingo_id === 'P300' && b.situacao === 'divergente' && b.klingo_id === null && l.itens.filter((i) => i.eu).length === 0 && l.pessoas[0].situacao === 'divergente', detalhe: JSON.stringify([a.situacao, a.klingo_id, b.situacao]) };
});
await caso('titular sem CPF: aparece como "sem_cpf" e nunca é conferido', async () => {
  await q(`update public.app_paciente set cpf = null where id = $1`, [PAC]);
  const l = await lista();
  await svc('app_laudos_pessoa_gravar', [PAC, 'eu', 'confere', 'P999']);
  const gravou = (await q(`select count(*)::int n from public.app_laudo_pessoa where paciente_id = $1 and klingo_id = 'P999'`, [PAC]))[0].n;
  await q(`update public.app_paciente set cpf = $1 where id = $2`, [CPF_ANA, PAC]);
  return { ok: l.pessoas[0].situacao === 'sem_cpf' && gravou === 0, detalhe: l.pessoas[0].situacao + ' gravou=' + gravou };
});
await caso('filho removido do cadastro: os laudos dele somem da lista e não baixam', async () => {
  await q(`update public.app_filho set removido_em = now() where id = $1`, [LEO]);
  const l = await lista(), p = await svc('app_laudos_pode', [TOK, '601']);
  await q(`update public.app_filho set removido_em = null where id = $1`, [LEO]);
  const volta = await svc('app_laudos_pode', [TOK, '601']);
  return { ok: l.itens.every((i) => i.eu) && p.ok === false && volta.ok === true, detalhe: `${p.erro} / volta=${volta.ok}` };
});
await caso('interruptor config.app_laudos = "nao": contexto e download são recusados na hora; "sim" liga de novo', async () => {
  await q(`update public.config set valor = 'nao' where chave = 'app_laudos'`);
  const a = await ctx(), b = await svc('app_laudos_pode', [TOK, '601']);
  await q(`update public.config set valor = 'sim' where chave = 'app_laudos'`);
  const c = await ctx(), d = await svc('app_laudos_pode', [TOK, '601']);
  return { ok: a.erro === 'desligado' && b.erro === 'desligado' && c.ok === true && d.ok === true, detalhe: [a.erro, b.erro, c.ok, d.ok].join(',') };
});
await caso('apagar o cadastro apaga junto a conferência e as marcações (sem sobra de dado de saúde)', async () => {
  await q(`delete from public.app_paciente where id = $1`, [PAC_BIA]);
  const n = (await q(`select (select count(*) from public.app_laudo where paciente_id = $1)::int a, (select count(*) from public.app_laudo_pessoa where paciente_id = $1)::int b`, [PAC_BIA]))[0];
  return { ok: n.a === 0 && n.b === 0 };
});

const falhou = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhou} de ${resultados.length} casos passaram`);
process.exit(falhou ? 1 : 0);
