// FLUXOGRAMA: entrada (o retrato da produção + acesso-rapido-paciente.sql + acesso-rapido-chat.sql; conversas abertas pelo motor REAL do chat: chat_iniciar, chat_responder, fluxo_*) -> validação (cada chamada como "anon", a chave pública do chat) -> lógica (a 1ª vez o CPF digitado na conversa é guardado no cadastro; nas conversas seguintes o motor pula cpf_nasc sozinho, pelo mesmo caminho do chat; filho tem o próprio CPF; conversa de outro celular, criança fora do cadastro e aparelho travado não mexem em nada; o CPF nunca volta inteiro para o navegador) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 14/11/2026 / Mudança: Implementação inicial (acesso rápido dentro do chat real)
// Dados: todos inventados neste arquivo (CPF 529.982.247-25 e 111.444.777-35 são os CPFs de exemplo que passam na conferência). Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-paciente.sql`, 'utf8'));
const sqlChat = readFileSync(`${REPO}/supabase/acesso-rapido-chat.sql`, 'utf8');
const sqlMensagem = readFileSync(`${REPO}/supabase/acesso-rapido-chat-dados-na-mensagem.sql`, 'utf8');   // 18/11/2026: a mensagem mostra nome, CPF mascarado e nascimento
const sqlMensagem2 = readFileSync(`${REPO}/supabase/acesso-rapido-chat-mensagem-dados-carregados.sql`, 'utf8');   // 19/11/2026: a 1ª linha passa a ser "Dados carregados do acesso rápido."  (aplicada depois da anterior)
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('acesso-rapido-chat.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sqlChat); await db.exec(sqlChat); return { ok: true }; });
await caso('acesso-rapido-chat-dados-na-mensagem.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sqlMensagem); await db.exec(sqlMensagem); return { ok: true }; });
await caso('acesso-rapido-chat-mensagem-dados-carregados.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sqlMensagem2); await db.exec(sqlMensagem2); return { ok: true }; });
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);

const rpc = async (nome, args) => {   // como o supabase-js: parâmetros nomeados, como anon
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
const dono = (sql, p) => q(sql, p);
const CPF_ANA = '52998224725', CPF_ANA_TXT = '529.982.247-25', CPF_LEO_TXT = '111.444.777-35';
const NASC_ANA = '1988-04-12', NASC_LEO = '2019-08-30';
const TEL_ANA = '71991230001', TEL_BIA = '71991230002';

const cad = (tel, nome, nasc, filhos = []) => rpc('app_cadastrar', { p_telefone: tel, p_nome: nome, p_nascimento: nasc, p_pin: '1357', p_filhos: filhos, p_aparelho: 'teste' });
const ana = await cad(TEL_ANA, 'Ana Souza Teste', NASC_ANA, [{ nome: 'Leo Souza Teste', nascimento: NASC_LEO }]);
const TOK = ana.token;
const iniciar = async (nome, tel, tipo = 'proprio', filho = null, email = 'ana@exemplo.invalid') => {
  await dono(`update public.conversas set criado_em = criado_em - interval '2 hours'`);   // o chat limita 5 conversas por hora por celular
  const r = await rpc('chat_iniciar', { p_nome: nome, p_telefone: tel, p_email: email, p_aceite: true, p_paciente_tipo: tipo, ...(filho ? { p_paciente_nome: filho } : {}) });
  return { c: r.conversa_id, t: r.token, passo: r.respostas.at(-1).opcoes?.passo };
};
const passoDe = async (c) => (await um(`select passo from public.conversa_fluxo where conversa_id = $1`, [c.c])).passo;
const digitar = (c, passo, valor) => rpc('chat_responder', { p_conversa: c.c, p_token: c.t, p_passo: passo, p_valor: valor, p_texto: 'Enviado.' });
const dados = (c, tok = TOK) => rpc('app_chat_dados', { p_token: tok, p_conversa: c.c, p_conv_token: c.t });
const perfil = async () => (await rpc('app_perfil', { p_token: TOK })).perfil;

await caso('cadastro por celular + PIN já existe (base do teste)', async () => ({ ok: ana.ok === true && ana.perfil.filhos.length === 1 }));

await caso('o interruptor: app_ativo é público; desligado, o chat não oferece nada e app_chat_dados responde "indisponivel"', async () => {
  const on = await rpc('app_ativo', {});
  await db.exec(`update public.config set valor = 'nao' where chave = 'app_acesso_modo'`);
  const off = await rpc('app_ativo', {}); const c0 = await iniciar('Ana Souza Teste', TEL_ANA); const r = await dados(c0);
  await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);
  return { ok: on === true && off === false && r.erro === 'indisponivel', detalhe: `${on} ${off} ${r.erro}` };
});

// ---------------------------------------------------------------- 1ª conversa: ainda não há CPF salvo
let c1;
await caso('1ª conversa: o motor abre em cpf_nasc e, sem CPF salvo, app_chat_dados não responde nada', async () => {
  c1 = await iniciar('Ana Souza Teste', TEL_ANA);
  const r = await dados(c1);
  return { ok: c1.passo === 'cpf_nasc' && r.ok === true && r.respondeu === 0 && r.guardou === false && (await passoDe(c1)) === 'cpf_nasc', detalhe: `${c1.passo} ${JSON.stringify(r)}` };
});
await caso('a pessoa digita CPF e nascimento: o cadastro guarda o CPF (e o e-mail) sozinho', async () => {
  const d = await digitar(c1, 'cpf_nasc', { cpf: CPF_ANA_TXT, dt_nasc: '12/04/1988' });
  const r = await dados(c1);
  const p = await perfil();
  const linha = (await dono(`select cpf, email from public.app_paciente`))[0];
  return { ok: r.guardou === true && p.cpf_salvo === true && p.cpf_mascara === '***.***.***-25' && linha.cpf === CPF_ANA && linha.email === 'ana@exemplo.invalid' && !!d.respostas, detalhe: p.cpf_mascara };
});
await caso('o navegador nunca recebe o CPF inteiro (só a máscara), nem pelo perfil nem pela resposta da função', async () => {
  const p = await rpc('app_perfil', { p_token: TOK }); const r = await dados(c1);
  const txt = JSON.stringify([p, r]);
  return { ok: !txt.includes(CPF_ANA) && !txt.includes('529.982') && !txt.includes('52998224'), detalhe: '' };
});

// ---------------------------------------------------------------- 2ª conversa: o CPF não é pedido de novo
let c2;
await caso('2ª conversa: o motor nasce em cpf_nasc e app_chat_dados responde sozinho; a conversa já passa para a próxima pergunta', async () => {
  c2 = await iniciar('Ana Souza Teste', TEL_ANA);
  const antes = c2.passo;
  const r = await dados(c2);
  const depois = await passoDe(c2);
  return { ok: antes === 'cpf_nasc' && r.ok === true && r.respondeu >= 1 && !['cpf_nasc'].includes(depois), detalhe: `${antes} → ${depois} (${r.respondeu} resposta(s))` };
});
await caso('o motor recebeu CPF e nascimento como se tivessem sido digitados (a conversa tem os dois e a mensagem não mostra o CPF)', async () => {
  const pa = (await dono(`select paciente from public.pre_agendamentos where conversa_id = $1`, [c2.c]))[0].paciente;
  const msg = await dono(`select texto from public.mensagens where conversa_id = $1 and autor = 'cliente' order by id`, [c2.c]);
  const f = (await dono(`select dados -> 'digitado' as dg from public.conversa_fluxo where conversa_id = $1`, [c2.c]))[0].dg;
  return { ok: pa.cpf === CPF_ANA && String(pa.dt_nasc).startsWith('1988-04-12') && msg.length >= 1 && msg.every((m) => !/529|52998/.test(m.texto)) && /^Dados carregados do acesso rápido\./.test(msg[0].texto) && f.cpf === CPF_ANA,
    detalhe: JSON.stringify(msg.map((m) => m.texto)) };
});
await caso('a mensagem do paciente mostra os dados dele: nome, CPF só mascarado e nascimento', async () => {
  const msg = await dono(`select texto from public.mensagens where conversa_id = $1 and autor = 'cliente' order by id`, [c2.c]);
  const t = msg[0].texto;
  return { ok: t.split('\n')[0] === 'Dados carregados do acesso rápido.' && !/Usei os dados/.test(t) && /Nome: Ana Souza Teste/.test(t) && /CPF: \*\*\*\.\*\*\*\.\*\*\*-25/.test(t) && /Nascimento: 12\/04\/1988/.test(t) && !/52998224725|529\.982/.test(t), detalhe: JSON.stringify(t) };
});
await caso('chamar de novo na mesma conversa não repete nada (a pergunta já foi respondida)', async () => {
  const antes = await passoDe(c2);
  const r = await dados(c2);
  return { ok: r.ok === true && r.respondeu === 0 && (await passoDe(c2)) === antes };
});

// ---------------------------------------------------------------- filho: CPF próprio
let cl1, cl2;
await caso('conversa para o filho cadastrado: CPF dele (ou do responsável) é aprendido separado do da mãe', async () => {
  cl1 = await iniciar('Ana Souza Teste', TEL_ANA, 'filho', 'Leo  Souza TESTE');
  const sem = await dados(cl1);
  await digitar(cl1, 'cpf_nasc', { cpf: CPF_LEO_TXT, dt_nasc: '30/08/2019' });
  const r = await dados(cl1);
  const p = await perfil();
  const leo = p.filhos[0];
  return { ok: sem.respondeu === 0 && r.guardou === true && leo.cpf_salvo === true && leo.cpf_mascara === '***.***.***-35' && p.cpf_mascara === '***.***.***-25', detalhe: `${leo.cpf_mascara} / ${p.cpf_mascara}` };
});
await caso('próxima conversa do filho: responde com o CPF e o nascimento do filho (não os da mãe)', async () => {
  cl2 = await iniciar('Ana Souza Teste', TEL_ANA, 'filho', 'Leo Souza Teste');
  const r = await dados(cl2);
  const pa = (await dono(`select paciente from public.pre_agendamentos where conversa_id = $1`, [cl2.c]))[0].paciente;
  return { ok: r.respondeu >= 1 && pa.cpf === '11144477735' && String(pa.dt_nasc).startsWith('2019-08-30') && (await passoDe(cl2)) !== 'cpf_nasc', detalhe: JSON.stringify(pa) };
});
await caso('criança que não está no cadastro (digitada à mão): nada é respondido nem guardado, o chat pergunta normalmente', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA, 'filho', 'Pedro Fulano Teste');
  const r = await dados(c);
  return { ok: r.ok === false && r.erro === 'pessoa' && (await passoDe(c)) === 'cpf_nasc' };
});

// ---------------------------------------------------------------- limites
await caso('conversa de OUTRO celular não é tocada, mesmo com o aparelho desbloqueado da Ana', async () => {
  const c = await iniciar('Bia Amiga Teste', TEL_BIA);
  const r = await dados(c);
  return { ok: r.ok === false && r.erro === 'celular' && (await passoDe(c)) === 'cpf_nasc' };
});
await caso('código da conversa errado: recusado', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA);
  const r = await rpc('app_chat_dados', { p_token: TOK, p_conversa: c.c, p_conv_token: 'x'.repeat(40) });
  return { ok: r.ok === false && r.erro === 'conversa' && (await passoDe(c)) === 'cpf_nasc' };
});
await caso('aparelho travado (30 min sem uso) ou desconhecido: nada é respondido', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA);
  await dono(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const travado = await dados(c);
  const desconhecido = await dados(c, 'z'.repeat(64));
  await dono(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  return { ok: travado.erro === 'bloqueado' && desconhecido.erro === 'sessao' && (await passoDe(c)) === 'cpf_nasc', detalhe: `${travado.erro} ${desconhecido.erro}` };
});
await caso('o CPF só é guardado se o motor o aceitou como digitado nesta conversa (conversa sem digitação não grava nada)', async () => {
  await dono(`update public.app_paciente set cpf = null`);
  const c = await iniciar('Ana Souza Teste', TEL_ANA);
  await dados(c);
  const n = (await dono(`select count(*)::int n from public.app_paciente where cpf is not null`))[0].n;
  await dono(`update public.app_paciente set cpf = $1`, [CPF_ANA]);
  return { ok: n === 0 };
});

// ---------------------------------------------------------------- Meus dados
await caso('Meus dados: CPF inválido é recusado; válido é guardado; vazio apaga; filho de outra pessoa não é aceito', async () => {
  const ruim = await rpc('app_pessoa_cpf_salvar', { p_token: TOK, p_pessoa: 'eu', p_cpf: '111.111.111-11' });
  const curto = await rpc('app_pessoa_cpf_salvar', { p_token: TOK, p_pessoa: 'eu', p_cpf: '123' });
  const bom = await rpc('app_pessoa_cpf_salvar', { p_token: TOK, p_pessoa: 'eu', p_cpf: CPF_LEO_TXT });
  const apaga = await rpc('app_pessoa_cpf_salvar', { p_token: TOK, p_pessoa: 'eu', p_cpf: '' });
  const outra = await cad('71991230077', 'Carla Lima Teste', '1980-01-01', [{ nome: 'Pedro Lima Teste', nascimento: '2018-01-01' }]);
  const alheio = await rpc('app_pessoa_cpf_salvar', { p_token: TOK, p_pessoa: outra.perfil.filhos[0].id, p_cpf: CPF_ANA_TXT });
  const ruimPessoa = await rpc('app_pessoa_cpf_salvar', { p_token: TOK, p_pessoa: 'qualquer', p_cpf: CPF_ANA_TXT });
  await rpc('app_pessoa_cpf_salvar', { p_token: TOK, p_pessoa: 'eu', p_cpf: CPF_ANA_TXT });
  return { ok: ruim.erro === 'cpf' && curto.erro === 'cpf' && bom.ok === true && bom.perfil.cpf_mascara === '***.***.***-35' && apaga.perfil.cpf_salvo === false && alheio.erro === 'pessoa' && ruimPessoa.erro === 'pessoa' };
});
await caso('quem acompanha como número de confiança nunca recebe CPF', async () => {
  await dono(`insert into public.app_contato_confianca (responsavel_id, nome, telefone, relacao, codigo) select id, 'Bia Amiga', '${TEL_BIA}', 'Irmão(ã)', '123456' from public.app_paciente where telefone = '${TEL_ANA}'`);
  const bia = await cad(TEL_BIA, 'Beatriz Amiga Teste', '1990-02-02');
  const vinc = await rpc('app_confianca_aceitar', { p_token: bia.token, p_codigo: '123456' });
  const txt = JSON.stringify(vinc.perfil.confiam_em_mim);
  return { ok: vinc.ok === true && vinc.perfil.confiam_em_mim.length === 1 && !/cpf|529|111\.444|11144477735|52998224725/.test(txt), detalhe: '' };
});
await caso('o público não executa nada além das três funções novas (internas continuam fechadas)', async () => {
  await anonimo(); const r = [];
  try { for (const s of [`select public.app_cpf_mascara('52998224725')`, `select public.app_perfil_json(gen_random_uuid())`]) { try { await db.query(s); r.push(false); } catch (e) { r.push(/permission denied/i.test(e.message)); } } }
  finally { await db.exec('reset role'); }
  const cols = (await q(`select has_column_privilege('anon', 'public.app_paciente', 'cpf', 'select') a, has_column_privilege('anon', 'public.app_filho', 'cpf', 'select') b`))[0];
  return { ok: r.every(Boolean) && !cols.a && !cols.b, detalhe: JSON.stringify(r) };
});

const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} passaram.`);
process.exit(falhasN ? 1 : 0);
