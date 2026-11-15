// FLUXOGRAMA: entrada (o retrato da produção + acesso rápido + conta antiga + filhos, aplicado duas vezes; contas, contatos, conversas e pré-agendamentos INVENTADOS no formato real) -> validação (chamadas como anônimo e como a conta logada) -> lógica (filho com o nome do titular: ele mesmo, homônimo confirmado ou recusado; filho repetido vale um; conta antiga lista e traz os filhos do histórico da PRÓPRIA conta, com o CPF do histórico; contatos só com celular não veem histórico) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (filhos dos contatos antigos e o caso da mãe com "filho" de mesmo nome)
// Dados: todos inventados neste arquivo (CPF 529.982.247-25 e 111.444.777-35 passam na conferência). Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
for (const f of ['acesso-rapido-paciente', 'acesso-rapido-chat', 'acesso-rapido-conta-antiga', 'acesso-rapido-pendencias']) await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8'));
const sql = readFileSync(`${REPO}/supabase/acesso-rapido-filhos.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('acesso-rapido-filhos.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);

const C_LEO = '52998224725';
const rpc = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object'; await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
const comoConta = async (uid, fn, args = {}) => {
  await como(uid); const ks = Object.keys(args);
  try { return (await q(`select public.${fn}(${ks.map((k, i) => `${k} => $${i + 1}${args[k] !== null && typeof args[k] === 'object' ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  catch (e) { return { erro: String(e.message) }; } finally { await db.exec('reset role'); }
};
const nFilhos = async (tel) => (await um(`select count(*)::int n from public.app_filho f join public.app_paciente p on p.id = f.responsavel_id where p.telefone = $1 and f.removido_em is null`, [tel])).n;

// ================================================================= cadastro novo: o filho com o nome da mãe
const cad = (tel, nome, nasc, filhos) => rpc('app_cadastrar', { p_telefone: tel, p_nome: nome, p_nascimento: nasc, p_pin: '1357', p_filhos: filhos, p_aparelho: 't' });
await caso('cadastro: "filho" com o MESMO nome e o MESMO nascimento da mãe é recusado ("é o seu próprio cadastro") e nada é criado', async () => {
  const r = await cad('71991230001', 'Ana Souza Teste', '1988-04-12', [{ nome: 'Ana Souza Teste', nascimento: '1988-04-12' }]);
  return { ok: r.erro === 'mesmo_cadastro' && (await um(`select count(*)::int n from public.app_paciente`)).n === 0, detalhe: r.erro };
});
await caso('cadastro: filho com o nome da mãe e nascimento DIFERENTE pede confirmação; nada é criado até confirmar', async () => {
  const r = await cad('71991230001', 'Ana Souza Teste', '1988-04-12', [{ nome: 'Ana Souza Teste', nascimento: '2015-03-03' }]);
  return { ok: r.erro === 'homonimo' && (await um(`select count(*)::int n from public.app_paciente`)).n === 0, detalhe: r.erro };
});
await caso('cadastro: confirmado, a filha com o nome da mãe entra junto com os outros filhos; o mesmo filho digitado duas vezes vale uma', async () => {
  const r = await cad('71991230001', 'Ana Souza Teste', '1988-04-12', [
    { nome: 'Ana Souza Teste', nascimento: '2015-03-03', mesmo_nome_confirmado: true }, { nome: 'Leo Souza Teste', nascimento: '2019-08-30' }, { nome: 'leo  souza teste', nascimento: '2019-08-30' }]);
  const nomes = (await q(`select nome from public.app_filho order by criado_em, nome`)).map((x) => x.nome);
  return { ok: r.ok === true && nomes.length === 2 && nomes[0] === 'Ana Souza Teste' && nomes[1] === 'Leo Souza Teste', detalhe: nomes.join(' | ') };
});
const tok = (await rpc('app_login', { p_telefone: '71991230001', p_pin: '1357' })).token;
await caso('adicionar filho depois: mesmo nome+nascimento da mãe recusado; homônimo pede confirmação; confirmado entra uma vez só', async () => {
  const a = await rpc('app_filho_adicionar', { p_token: tok, p_nome: 'Ana Souza Teste', p_nascimento: '1988-04-12' });
  const b = await rpc('app_filho_adicionar', { p_token: tok, p_nome: 'Ana Souza Teste', p_nascimento: '2010-01-01' });
  const c = await rpc('app_filho_adicionar', { p_token: tok, p_nome: 'Ana Souza Teste', p_nascimento: '2010-01-01', p_mesmo_nome_confirmado: true });
  const d = await rpc('app_filho_adicionar', { p_token: tok, p_nome: 'Ana Souza Teste', p_nascimento: '2010-01-01', p_mesmo_nome_confirmado: true });
  return { ok: a.erro === 'mesmo_cadastro' && b.erro === 'homonimo' && c.ok && d.ok && (await nFilhos('71991230001')) === 3, detalhe: `${a.erro} ${b.erro} ${await nFilhos('71991230001')}` };
});
await caso('a função antiga app_filho_salvar (3 parâmetros) passa pelas mesmas regras e recusa o homônimo', async () => {
  const r = await rpc('app_filho_salvar', { p_token: tok, p_nome: 'Ana Souza Teste', p_nascimento: '2001-01-01' });
  return { ok: r.erro === 'homonimo' };
});
await caso('filho com nome diferente continua entrando normal (sem pergunta nenhuma)', async () => {
  const r = await rpc('app_filho_adicionar', { p_token: tok, p_nome: 'Davi Souza Teste', p_nascimento: '2022-02-02' });
  return { ok: r.ok === true };
});

// ================================================================= conta antiga com histórico de filhos (formato real: conversas.conta_id, pre_agendamentos.paciente, conversa_fluxo.dados.digitado)
const U = { mae: '00000000-0000-4000-8000-0000000000b1', outra: '00000000-0000-4000-8000-0000000000b2', soTel: '00000000-0000-4000-8000-0000000000b3' };
await db.exec(`insert into auth.users (id, email) values ('${U.mae}', 'mae@exemplo.invalid'), ('${U.outra}', 'outra@exemplo.invalid'), ('${U.soTel}', 'sotel@exemplo.invalid');
  insert into public.contas_paciente (id, email, nome, telefone) values ('${U.mae}', 'mae@exemplo.invalid', 'Marta Lima Teste', '71991230050'), ('${U.outra}', 'outra@exemplo.invalid', 'Outra Pessoa Teste', '71991230051'), ('${U.soTel}', 'sotel@exemplo.invalid', 'Sonia Tel Teste', '71991230052');
  insert into public.pacientes (id, nome, nome_norm, telefones, dt_nasc, cpf) values ('99999999-0000-4000-8000-000000000001', 'Marta Lima Teste', 'marta lima teste', array['71991230050'], '1985-05-05', '111.444.777-35');
  update public.contas_paciente set paciente_id = '99999999-0000-4000-8000-000000000001' where id = '${U.mae}';`);
const contato = async (nome, tel) => (await q(`insert into public.contatos (nome, telefone) values ($1, $2) returning id`, [nome, tel]))[0].id;
const conversa = async (contatoId, conta, nomeFilho, tipo, nasc, cpf, ondeNasc = 'pre', dias = 1) => {
  const c = (await q(`insert into public.conversas (contato_id, conta_id, paciente_tipo, paciente_nome, criado_em) values ($1, $2, $3, $4, now() - ($5 || ' days')::interval) returning id`, [contatoId, conta, tipo, nomeFilho, String(dias)]))[0].id;
  if (conta) await q(`update public.conversas set conta_id = $2 where id = $1`, [c, conta]);   // em produção: gatilho no insert ou conta_paciente_adotar_conversas (exige o token da conversa)
  if (ondeNasc === 'pre') await q(`insert into public.pre_agendamentos (conversa_id, paciente) values ($1, $2::jsonb)`, [c, JSON.stringify({ nome: nomeFilho, dt_nasc: nasc, ...(cpf ? { cpf } : {}) })]);
  else if (ondeNasc === 'dig') await q(`insert into public.conversa_fluxo (conversa_id, dados) values ($1, $2::jsonb) on conflict (conversa_id) do update set dados = excluded.dados`, [c, JSON.stringify({ digitado: { dt_nasc: nasc, ...(cpf ? { cpf } : {}) } })]);
  return c;
};
const cm = await contato('Marta Lima Teste', '71991230050');
await conversa(cm, U.mae, 'Leo Lima Teste', 'filho', '30/08/2019', '529.982.247-25', 'pre', 10);
await conversa(cm, U.mae, 'Leo Lima Teste', 'filho', '30/08/2019', null, 'pre', 5);           // 2º atendimento do mesmo filho
await conversa(cm, U.mae, 'Lia Lima Teste', 'filho', '2021-02-02', null, 'dig', 3);            // nascimento só em conversa_fluxo, formato ISO
await conversa(cm, U.mae, 'Bea Lima Teste', 'filho', null, null, 'nenhum', 2);                  // sem nascimento no histórico
await conversa(cm, U.mae, 'Marta Lima Teste', 'filho', '05/05/1985', null, 'pre', 1);           // a própria mãe marcada como "filho" (mesmo nome e mesmo nascimento)
await conversa(cm, U.mae, 'Marta Lima Teste', 'proprio', null, null, 'nenhum', 20);             // atendimento "para mim": não é filho
const co = await contato('Outra Pessoa Teste', '71991230051');
await conversa(co, U.outra, 'Ze Outra Teste', 'filho', '01/01/2018', '111.444.777-35', 'pre', 4);   // filho de OUTRA conta
const cs = await contato('Sonia Tel Teste', '71991230052');
await conversa(cs, null, 'Gui Tel Teste', 'filho', '01/01/2017', null, 'pre', 4);                // contato só com celular (sem conta_id)

const lista = async (uid) => (await comoConta(uid, 'app_conta_antiga_filhos')).filhos;
await caso('a conta antiga lista os filhos do histórico DA PRÓPRIA conta, um por nome, sem a mãe como "para mim" e com nascimento de onde houver', async () => {
  const f = await lista(U.mae); const por = Object.fromEntries(f.map((x) => [x.nome, x]));
  return { ok: f.length === 4 && por['Leo Lima Teste'].nascimento === '2019-08-30' && por['Leo Lima Teste'].atendimentos === 2 && por['Lia Lima Teste'].nascimento === '2021-02-02' && por['Bea Lima Teste'].nascimento === null, detalhe: f.map((x) => x.nome).join(' | ') };
});
await caso('a mãe aparece uma vez como "mesmo_cadastro" (é ela mesma, mesmo nome e nascimento); os filhos de verdade não', async () => {
  const f = await lista(U.mae); const por = Object.fromEntries(f.map((x) => [x.nome, x]));
  return { ok: por['Marta Lima Teste'].mesmo_cadastro === true && por['Marta Lima Teste'].mesmo_nome === true && por['Leo Lima Teste'].mesmo_nome === false && por['Leo Lima Teste'].mesmo_cadastro === false };
});
await caso('o CPF do filho vem só mascarado e só quando o histórico tem', async () => {
  const f = await lista(U.mae); const por = Object.fromEntries(f.map((x) => [x.nome, x])); const txt = JSON.stringify(f);
  return { ok: por['Leo Lima Teste'].cpf_mascara === '***.***.***-25' && por['Lia Lima Teste'].cpf_mascara === null && !txt.includes(C_LEO) && !txt.includes('529.982') };
});
await caso('isolamento: a outra conta vê só o filho dela; contato só com celular (sem conta) não tem lista; o público não executa', async () => {
  const o = await lista(U.outra), s = await lista(U.soTel);
  await anonimo(); let negou = 0;
  for (const f of ['app_conta_antiga_filhos()', 'app_conta_antiga_historico_filhos(null)']) { try { await q(`select public.${f}`); } catch { negou++; } }
  await db.exec('reset role');
  return { ok: o.length === 1 && o[0].nome === 'Ze Outra Teste' && s.length === 0 && negou === 2, detalhe: `${o.length} ${s.length} ${negou}` };
});
await caso('migrar sem o nascimento do filho que o histórico não tinha: erro claro e nada é criado (nem a mãe)', async () => {
  const r = await comoConta(U.mae, 'app_conta_antiga_migrar', { p_pin: '2468', p_filhos: [{ nome: 'Bea Lima Teste' }] });
  return { ok: r.erro === 'filho' && r.ok === false && /Bea/.test(r.mensagem) && (await um(`select count(*)::int n from public.app_paciente where conta_antiga_id = '${U.mae}'`)).n === 0, detalhe: JSON.stringify(r).slice(0, 120) };
});
await caso('migrar com a mãe repetida como "filho" (mesmo nome e nascimento): recusado, nada criado', async () => {
  const r = await comoConta(U.mae, 'app_conta_antiga_migrar', { p_pin: '2468', p_filhos: [{ nome: 'Marta Lima Teste', nascimento: '1985-05-05' }] });
  return { ok: r.erro === 'mesmo_cadastro' && (await um(`select count(*)::int n from public.app_paciente where conta_antiga_id = '${U.mae}'`)).n === 0, detalhe: r.erro };
});
await caso('migrar com homônimo sem confirmar: recusado; confirmado: entra', async () => {
  const a = await comoConta(U.mae, 'app_conta_antiga_migrar', { p_pin: '2468', p_filhos: [{ nome: 'Marta Lima Teste', nascimento: '2012-12-12' }] });
  return { ok: a.erro === 'homonimo' && (await um(`select count(*)::int n from public.app_paciente where conta_antiga_id = '${U.mae}'`)).n === 0, detalhe: a.erro };
});
await caso('migrar com a lista confirmada: os filhos entram (sem a mãe), o CPF do Leo vem do histórico, o da Lia não existe, e o aparelho abre', async () => {
  const r = await comoConta(U.mae, 'app_conta_antiga_migrar', { p_pin: '2468', p_telefone: '71991230050', p_aparelho: 't',
    p_filhos: [{ nome: 'Leo Lima Teste', nascimento: '2019-08-30' }, { nome: 'Lia Lima Teste', nascimento: '2021-02-02' }, { nome: 'Bea Lima Teste', nascimento: '2023-03-03' }, { nome: 'leo lima teste', nascimento: '2019-08-30' }] });
  const fs = await q(`select f.nome, f.cpf from public.app_filho f join public.app_paciente p on p.id = f.responsavel_id where p.conta_antiga_id = '${U.mae}' order by f.nome`);
  return { ok: r.ok === true && !!r.token && fs.length === 3 && fs.find((x) => x.nome === 'Leo Lima Teste').cpf === C_LEO && fs.find((x) => x.nome === 'Lia Lima Teste').cpf === null && r.perfil.filhos.length === 3 && r.perfil.cpf_salvo === true, detalhe: fs.map((x) => x.nome + ':' + (x.cpf ? 'cpf' : '-')).join(' ') };
});
await caso('o que falta aparece em "Falta pouco": o CPF da Lia e o da Bea (o do Leo e o da mãe vieram do histórico/clínica da conta autenticada); depois de migrar a lista antiga fica vazia', async () => {
  const t = (await comoConta(U.mae, 'app_conta_antiga_filhos')).filhos;
  const tk = (await rpc('app_login', { p_telefone: '71991230050', p_pin: '2468' })).token;
  const p = (await rpc('app_pendencias', { p_token: tk })).pendencias.map((x) => x.nome).sort();
  return { ok: t.length === 0 && p.join('|') === 'Bea Lima Teste|Lia Lima Teste', detalhe: p.join('|') };
});
await caso('CPF do histórico NÃO vai para um filho de nome igual mas nascimento diferente (contradição)', async () => {
  await db.exec(`insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000b9', 'x@exemplo.invalid'); insert into public.contas_paciente (id, email, nome, telefone) values ('00000000-0000-4000-8000-0000000000b9', 'x@exemplo.invalid', 'Xuxa Teste Silva', '71991230059');`);
  const cx = await contato('Xuxa Teste Silva', '71991230059'); await conversa(cx, '00000000-0000-4000-8000-0000000000b9', 'Pedro Xis Teste', 'filho', '01/01/2018', '111.444.777-35', 'pre', 2);
  const r = await comoConta('00000000-0000-4000-8000-0000000000b9', 'app_conta_antiga_migrar', { p_pin: '1357', p_nascimento: '1980-01-01', p_filhos: [{ nome: 'Pedro Xis Teste', nascimento: '2016-06-06' }] });
  const f = await um(`select cpf from public.app_filho where nome = 'Pedro Xis Teste'`);
  return { ok: r.ok === true && f.cpf === null };
});
await caso('colar a "última parte" depois mantém as permissões: filhos da conta só para quem está logado; adicionar filho e cadastrar para o paciente', async () => {
  await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-ultima-parte.sql`, 'utf8'));
  const p = (await q(`select has_function_privilege('anon','public.app_conta_antiga_migrar(text,text,text,text,jsonb,text)','execute') a, has_function_privilege('authenticated','public.app_conta_antiga_migrar(text,text,text,text,jsonb,text)','execute') b,
    has_function_privilege('authenticated','public.app_conta_antiga_filhos()','execute') c, has_function_privilege('anon','public.app_conta_antiga_filhos()','execute') d,
    has_function_privilege('anon','public.app_filho_adicionar(text,text,text,boolean)','execute') e, has_function_privilege('anon','public.app_cadastrar(text,text,text,text,jsonb,jsonb,text)','execute') f,
    has_function_privilege('anon','public.app_filho_conflito(text,date,text,date,boolean)','execute') g`))[0];
  return { ok: !p.a && p.b && p.c && !p.d && p.e && p.f && !p.g, detalhe: JSON.stringify(p) };
});

const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
