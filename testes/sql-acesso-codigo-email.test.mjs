// FLUXOGRAMA: entrada (o retrato da produção + supabase/acesso-codigo-email.sql; equipe, pacientes e e-mails INVENTADOS) -> validação (com a chave desligada nada muda; ligada, cadastro e "esqueci o PIN" recusam sem código aceito; limites de pedidos e de erros; permissões) -> lógica (pedir, enviar, digitar, usar; a atendente vê, passa e descarta o código) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (confirmação por e-mail no primeiro acesso e no "esqueci o PIN").
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
const sql = readFileSync(`${REPO}/supabase/acesso-codigo-email.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('acesso-codigo-email.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.exec(`insert into public.config (chave, valor) values ('app_acesso_modo', 'sim') on conflict (chave) do update set valor = 'sim'`);

const ADM = '00000000-0000-4000-8000-0000000000e1', ATE = '00000000-0000-4000-8000-0000000000e2', MKT = '00000000-0000-4000-8000-0000000000e3';
await db.exec(`insert into auth.users (id, email) values ('${ADM}', 'adm@x.invalid'), ('${ATE}', 'ate@x.invalid'), ('${MKT}', 'mkt@x.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Adm Teste', 'adm@x.invalid', 'admin', true), ('${ATE}', 'Ate Teste', 'ate@x.invalid', 'atendente', true), ('${MKT}', 'Mkt Teste', 'mkt@x.invalid', 'marketing', true)
    on conflict (id) do update set papel = excluded.papel, ativo = true;`);
const rpcAnon = async (nome, args) => { const ks = Object.keys(args); await anonimo(); try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, ks.map((k) => args[k])))[0].r; } finally { await db.exec('reset role'); } };
const equipe = async (uid, fn, args = []) => { await como(uid); try { return (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args))[0].r; } catch (e) { return { erro: String(e.message) }; } finally { await db.exec('reset role'); } };
const ligar = (v) => db.exec(`update public.config set valor = '${v}' where chave = 'app_codigo_email'`);
const ultimo = (tel, fin) => um(`select * from public.app_codigo_email where telefone = $1 and finalidade = $2 and descartado_em is null order by criado_em desc limit 1`, [tel, fin]);
const cad = (tel, nome = 'Maria Teste Silva', extra = {}) => rpcAnon('app_cadastrar', { p_telefone: tel, p_nome: nome, p_nascimento: '1985-03-10', p_pin: '2580', p_aparelho: 't', ...extra });

// ---- chave desligada: tudo como antes ----
await caso('chave desligada: o pedido responde "não exigido" e o cadastro funciona sem código', async () => {
  const p = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230001', p_finalidade: 'cadastro', p_email: 'a@x.invalid' });
  const c = await cad('71991230001');
  const n = (await um(`select count(*)::int n from public.app_codigo_email`)).n;
  return { ok: p.ok === true && p.exigido === false && c.ok === true && n === 0, detalhe: JSON.stringify(p) };
});

await ligar('sim');
// ---- cadastro (celular novo) ----
await caso('ligada: cadastro direto, sem código, é recusado (erro codigo_email) e nada é criado', async () => {
  const c = await cad('71991230002');
  const n = (await um(`select count(*)::int n from public.app_paciente where telefone = '71991230002'`)).n;
  return { ok: c.ok === false && c.erro === 'codigo_email' && n === 0, detalhe: JSON.stringify(c) };
});
await caso('o mesmo vale chamando app_pin_criar (o caminho do chat com PIN obrigatório)', async () => {
  const c = await rpcAnon('app_pin_criar', { p_telefone: '71991230002', p_nome: 'Maria Teste Silva', p_nascimento: '1985-03-10', p_pin: '2580', p_cpf: '52998224725', p_aparelho: 't' });
  return { ok: c.ok === false && c.erro === 'codigo_email', detalhe: JSON.stringify(c) };
});
await caso('pedido sem e-mail válido é recusado; celular inválido também', async () => {
  const a = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230002', p_finalidade: 'cadastro', p_email: 'sem-arroba' });
  const b = await rpcAnon('app_codigo_pedir', { p_telefone: '123', p_finalidade: 'cadastro', p_email: 'a@x.invalid' });
  const c = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230002', p_finalidade: 'outra', p_email: 'a@x.invalid' });
  return { ok: a.erro === 'email' && b.erro === 'celular' && c.erro === 'finalidade', detalhe: `${a.erro} ${b.erro} ${c.erro}` };
});
await db.exec(`insert into public.config (chave, valor) values ('klingo_funcoes_base', 'https://funcoes.invalid/') on conflict (chave) do update set valor = excluded.valor;
  insert into vault.secrets_tbl (name, secret) values ('klingo_interno_segredo', 'segredo-de-teste') on conflict (name) do update set secret = excluded.secret`);
let cod1;
await caso('pedido válido: grava o código de 6 números, manda o banco chamar a função de e-mail e mostra o e-mail só mascarado', async () => {
  const p = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230002', p_finalidade: 'cadastro', p_email: 'Maria.Teste@X.invalid', p_nome: 'Maria Teste Silva' });
  cod1 = await ultimo('71991230002', 'cadastro');
  const chamada = await um(`select url, body, headers from net.chamadas order by id desc limit 1`);
  return { ok: p.ok === true && p.exigido === true && p.enviado === true && p.email_mascara === 'm***@x.invalid' && /^[0-9]{6}$/.test(cod1.codigo) && cod1.email === 'maria.teste@x.invalid' && cod1.envio === 'pendente'
    && chamada.url === 'https://funcoes.invalid/app-codigo-enviar' && chamada.body.id === cod1.id && chamada.headers['x-klingo-segredo'] === 'segredo-de-teste' && !JSON.stringify(chamada).includes(cod1.codigo), detalhe: JSON.stringify(p) };
});
await caso('o telefone de um cadastro já existente não recebe código de cadastro', async () => {
  const p = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230001', p_finalidade: 'cadastro', p_email: 'a@x.invalid' });
  return { ok: p.ok === false && p.erro === 'telefone_cadastrado', detalhe: JSON.stringify(p) };
});
await caso('código errado: conta tentativas e avisa quantas restam; com cadastro ainda recusado', async () => {
  const errado = cod1.codigo === '000000' ? '000001' : '000000';
  const a = await rpcAnon('app_codigo_validar', { p_telefone: '71991230002', p_finalidade: 'cadastro', p_codigo: errado });
  const c = await cad('71991230002');
  return { ok: a.ok === false && a.erro === 'codigo' && a.restantes === 4 && c.erro === 'codigo_email', detalhe: JSON.stringify(a) };
});
await caso('código com menos de 6 números é recusado sem gastar tentativa', async () => {
  const a = await rpcAnon('app_codigo_validar', { p_telefone: '71991230002', p_finalidade: 'cadastro', p_codigo: '123' });
  const t = (await ultimo('71991230002', 'cadastro')).tentativas;
  return { ok: a.erro === 'codigo' && t === 1, detalhe: `tentativas ${t}` };
});
await caso('código de outra finalidade ou de outro celular não vale', async () => {
  const a = await rpcAnon('app_codigo_validar', { p_telefone: '71991230002', p_finalidade: 'esqueci_pin', p_codigo: cod1.codigo });
  const b = await rpcAnon('app_codigo_validar', { p_telefone: '71991230009', p_finalidade: 'cadastro', p_codigo: cod1.codigo });
  return { ok: a.ok === false && a.erro === 'codigo_vencido' && b.ok === false && b.erro === 'codigo_vencido', detalhe: `${a.erro} ${b.erro}` };
});
await caso('código certo: aceito; depois o cadastro nasce, o e-mail confirmado é gravado e o código sai da lista', async () => {
  const a = await rpcAnon('app_codigo_validar', { p_telefone: '71991230002', p_finalidade: 'cadastro', p_codigo: cod1.codigo });
  const antes = await equipe(ATE, 'painel_app_codigos');
  const c = await cad('71991230002');
  const pac = await um(`select email from public.app_paciente where telefone = '71991230002'`);
  const usado = await um(`select usado_em is not null u from public.app_codigo_email where id = $1`, [cod1.id]);
  const depois = await equipe(ATE, 'painel_app_codigos');
  return { ok: a.ok === true && antes.some((l) => l.id === cod1.id && l.digitado === true) && c.ok === true && pac.email === 'maria.teste@x.invalid' && usado.u === true && !depois.some((l) => l.id === cod1.id), detalhe: JSON.stringify(c).slice(0, 60) };
});
await caso('um código usado não serve para criar outro cadastro (mesmo celular já existe; outro celular não tem código)', async () => {
  const c = await cad('71991230003');
  return { ok: c.ok === false && c.erro === 'codigo_email', detalhe: JSON.stringify(c) };
});
await caso('5 erros inutilizam o código: o certo deixa de valer e é preciso pedir outro', async () => {
  await rpcAnon('app_codigo_pedir', { p_telefone: '71991230004', p_finalidade: 'cadastro', p_email: 'b@x.invalid' });
  const c = await ultimo('71991230004', 'cadastro'); const errado = c.codigo === '111111' ? '222222' : '111111'; let ult;
  for (let i = 0; i < 5; i++) ult = await rpcAnon('app_codigo_validar', { p_telefone: '71991230004', p_finalidade: 'cadastro', p_codigo: errado });
  const certo = await rpcAnon('app_codigo_validar', { p_telefone: '71991230004', p_finalidade: 'cadastro', p_codigo: c.codigo });
  return { ok: ult.erro === 'codigo_bloqueado' && certo.ok === false && certo.erro === 'codigo_vencido', detalhe: `${ult.erro} ${certo.erro}` };
});
await caso('pedir de novo cancela o código anterior e no máximo 3 pedidos por hora por celular', async () => {
  const a = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230005', p_finalidade: 'cadastro', p_email: 'c@x.invalid' });
  const c1 = await ultimo('71991230005', 'cadastro');
  const b = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230005', p_finalidade: 'cadastro', p_email: 'c@x.invalid' });
  const velho = await um(`select descartado_em is not null d from public.app_codigo_email where id = $1`, [c1.id]);
  const c = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230005', p_finalidade: 'cadastro', p_email: 'c@x.invalid' });
  const d = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230005', p_finalidade: 'cadastro', p_email: 'c@x.invalid' });
  return { ok: a.ok && b.ok && c.ok && velho.d === true && d.ok === false && d.erro === 'muitos', detalhe: d.erro };
});
await caso('código vencido não vale e some da lista da equipe', async () => {
  await rpcAnon('app_codigo_pedir', { p_telefone: '71991230006', p_finalidade: 'cadastro', p_email: 'd@x.invalid' });
  const c = await ultimo('71991230006', 'cadastro');
  await db.exec(`update public.app_codigo_email set expira_em = now() - interval '1 minute' where id = '${c.id}'`);
  const v = await rpcAnon('app_codigo_validar', { p_telefone: '71991230006', p_finalidade: 'cadastro', p_codigo: c.codigo });
  const l = await equipe(ATE, 'painel_app_codigos');
  return { ok: v.erro === 'codigo_vencido' && !l.some((x) => x.id === c.id) };
});

// ---- esqueci o PIN ----
await db.exec(`update public.app_paciente set email = 'maria.teste@x.invalid' where telefone = '71991230002'`);
await caso('esqueci o PIN sem código aceito é recusado e o PIN antigo continua valendo', async () => {
  const r = await rpcAnon('app_pin_esqueci', { p_telefone: '71991230002', p_nome: 'Maria Teste Silva', p_nascimento: '1985-03-10', p_pin_novo: '9731', p_aparelho: 't2' });
  const login = await rpcAnon('app_login', { p_telefone: '71991230002', p_pin: '2580', p_aparelho: 't3' });
  return { ok: r.ok === false && r.erro === 'codigo_email' && login.ok === true, detalhe: JSON.stringify(r) };
});
await caso('pedido de código do esqueci com nome ou nascimento errado: recusa igual a "dados não conferem", conta nas tentativas do PIN e não cria código', async () => {
  const a = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230002', p_finalidade: 'esqueci_pin', p_nome: 'Outra Pessoa', p_nascimento: '1985-03-10' });
  const b = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230099', p_finalidade: 'esqueci_pin', p_nome: 'Maria Teste Silva', p_nascimento: '1985-03-10' });
  const n = (await um(`select count(*)::int n from public.app_codigo_email where finalidade = 'esqueci_pin'`)).n;
  const f = await um(`select pin_falhas from public.app_paciente where telefone = '71991230002'`);
  return { ok: a.erro === 'dados' && b.erro === 'dados' && n === 0 && f.pin_falhas >= 1, detalhe: JSON.stringify(a) };
});
let cod2;
await caso('pedido certo manda o código para o e-mail do cadastro (mascarado na resposta) e a equipe o enxerga', async () => {
  await db.exec(`update public.app_paciente set pin_falhas = 0, pin_bloqueado_ate = null where telefone = '71991230002'`);
  const p = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230002', p_finalidade: 'esqueci_pin', p_nome: 'maria teste silva', p_nascimento: '1985-03-10' });
  cod2 = await ultimo('71991230002', 'esqueci_pin');
  const l = await equipe(ATE, 'painel_app_codigos'); const linha = l.find((x) => x.id === cod2.id);
  return { ok: p.ok === true && p.enviado === true && p.email_mascara === 'm***@x.invalid' && linha && linha.codigo === cod2.codigo && linha.nome === 'Maria Teste Silva' && linha.celular === '71991230002' && linha.finalidade === 'esqueci_pin', detalhe: JSON.stringify(p) };
});
await caso('com o código aceito, o esqueci cria o novo PIN, derruba o aparelho antigo e consome o código', async () => {
  const v = await rpcAnon('app_codigo_validar', { p_telefone: '71991230002', p_finalidade: 'esqueci_pin', p_codigo: cod2.codigo });
  const r = await rpcAnon('app_pin_esqueci', { p_telefone: '71991230002', p_nome: 'Maria Teste Silva', p_nascimento: '1985-03-10', p_pin_novo: '9731', p_aparelho: 't2' });
  const login = await rpcAnon('app_login', { p_telefone: '71991230002', p_pin: '9731', p_aparelho: 't4' });
  const outra = await rpcAnon('app_pin_esqueci', { p_telefone: '71991230002', p_nome: 'Maria Teste Silva', p_nascimento: '1985-03-10', p_pin_novo: '8642', p_aparelho: 't5' });
  return { ok: v.ok === true && r.ok === true && login.ok === true && outra.erro === 'codigo_email', detalhe: JSON.stringify(r).slice(0, 80) };
});
await caso('cadastro sem e-mail: o pedido do esqueci gera código "sem_email" para a atendente passar (nada é enviado)', async () => {
  await cad('71991230007', 'Joana Sem Email Teste', { });   // codigo exigido: precisa do caminho normal primeiro
  await rpcAnon('app_codigo_pedir', { p_telefone: '71991230007', p_finalidade: 'cadastro', p_email: 'j@x.invalid' });
  const k = await ultimo('71991230007', 'cadastro');
  await rpcAnon('app_codigo_validar', { p_telefone: '71991230007', p_finalidade: 'cadastro', p_codigo: k.codigo });
  const c = await cad('71991230007', 'Joana Sem Email Teste');
  await db.exec(`update public.app_paciente set email = null where telefone = '71991230007'`);
  const antes = (await um(`select count(*)::int n from net.chamadas`)).n;
  const p = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230007', p_finalidade: 'esqueci_pin', p_nome: 'Joana Sem Email Teste', p_nascimento: '1985-03-10' });
  const dep = (await um(`select count(*)::int n from net.chamadas`)).n;
  const l = await equipe(ATE, 'painel_app_codigos'); const linha = l.find((x) => x.celular === '71991230007' && x.finalidade === 'esqueci_pin');
  return { ok: c.ok === true && p.ok === true && p.enviado === false && !p.email_mascara && dep === antes && linha && linha.envio === 'sem_email' && !linha.email, detalhe: JSON.stringify(p) };
});

// ---- envio de e-mail (Edge Function) e equipe ----
await caso('a função de e-mail só recebe o que precisa e anota o resultado; envio "pendente" há mais de 2 minutos aparece como erro', async () => {
  await rpcAnon('app_codigo_pedir', { p_telefone: '71991230008', p_finalidade: 'cadastro', p_email: 'e@x.invalid', p_nome: 'Eva Teste Souza' });
  const c = await ultimo('71991230008', 'cadastro');
  const para = (await um(`select public.app_codigo_para_enviar($1::uuid) r`, [c.id])).r;
  await db.exec(`update public.app_codigo_email set criado_em = now() - interval '3 minutes' where id = '${c.id}'`);
  const atrasado = (await equipe(ATE, 'painel_app_codigos')).find((x) => x.id === c.id);
  await db.exec(`select public.app_codigo_envio_marcar('${c.id}', false, 'smtp 535 senha recusada')`);
  const erro = (await equipe(ATE, 'painel_app_codigos')).find((x) => x.id === c.id);
  const reenvio = (await um(`select public.app_codigo_para_enviar($1::uuid) r`, [c.id])).r;
  await db.exec(`select public.app_codigo_envio_marcar('${c.id}', true)`);
  const ok = (await equipe(ATE, 'painel_app_codigos')).find((x) => x.id === c.id);
  return { ok: para.email === 'e@x.invalid' && para.codigo === c.codigo && atrasado.envio === 'erro' && erro.envio === 'erro' && erro.envio_erro === 'smtp 535 senha recusada' && reenvio === null && ok.envio === 'enviado' && ok.envio_erro === null, detalhe: JSON.stringify(atrasado.envio) };
});
await caso('contador do botão Pendências: conta só os códigos ainda não digitados; admin e atendente leem, marketing e público não', async () => {
  const r = await equipe(ADM, 'painel_app_pendencias_resumo'), m = await equipe(MKT, 'painel_app_codigos'), m2 = await equipe(MKT, 'painel_app_codigo_descartar', ['00000000-0000-4000-8000-000000000000']);
  const ativos = await equipe(ATE, 'painel_app_codigos');
  await anonimo(); let negou = 0;
  for (const f of ['painel_app_codigos()', 'painel_app_pendencias_resumo()', `app_codigo_para_enviar('00000000-0000-4000-8000-000000000000')`, `app_codigo_exigido()`]) { try { await q(`select public.${f}`); } catch { negou++; } }
  let lerTabela = false; try { await q(`select * from public.app_codigo_email`); lerTabela = true; } catch { /* esperado */ }
  await db.exec('reset role');
  return { ok: r.codigos === ativos.filter((x) => !x.digitado).length && r.codigos >= 2 && r.contas_antigas !== undefined && /Só a equipe/.test(m.erro || '') && /Só a equipe/.test(m2.erro || '') && negou === 4 && lerTabela === false, detalhe: `${r.codigos} ${negou}` };
});
await caso('descartar: o código some da lista e deixa de valer; descartar de novo não faz nada', async () => {
  const l = await equipe(ATE, 'painel_app_codigos'); const alvo = l.find((x) => x.celular === '71991230008');
  const a = await equipe(ATE, 'painel_app_codigo_descartar', [alvo.id]), b = await equipe(ATE, 'painel_app_codigo_descartar', [alvo.id]);
  const depois = await equipe(ATE, 'painel_app_codigos');
  const v = await rpcAnon('app_codigo_validar', { p_telefone: '71991230008', p_finalidade: 'cadastro', p_codigo: alvo.codigo });
  return { ok: a === 1 && b === 0 && !depois.some((x) => x.id === alvo.id) && v.erro === 'codigo_vencido', detalhe: `${a} ${b}` };
});
await caso('a atendente passa o código por telefone: vale como o do e-mail (e-mail com erro de envio não impede)', async () => {
  await db.exec(`update public.config set valor = '' where chave = 'klingo_funcoes_base'`);   // sem como chamar a função de e-mail
  const p = await rpcAnon('app_codigo_pedir', { p_telefone: '71991230010', p_finalidade: 'cadastro', p_email: 'k@x.invalid', p_nome: 'Kelly Teste Lima' });
  const linha = (await equipe(ATE, 'painel_app_codigos')).find((x) => x.celular === '71991230010');
  const v = await rpcAnon('app_codigo_validar', { p_telefone: '71991230010', p_finalidade: 'cadastro', p_codigo: linha.codigo });
  const c = await cad('71991230010', 'Kelly Teste Lima');
  return { ok: p.ok === true && linha.envio === 'pendente' && v.ok === true && c.ok === true };
});
await caso('registros com mais de 3 dias perdem nome, e-mail, celular e código no próximo pedido', async () => {
  await db.exec(`update public.app_codigo_email set criado_em = now() - interval '4 days' where telefone = '71991230010' and finalidade = 'cadastro'`);
  await rpcAnon('app_codigo_pedir', { p_telefone: '71991230012', p_finalidade: 'cadastro', p_email: 'z@x.invalid' });
  const velho = await um(`select count(*)::int n from public.app_codigo_email where telefone = '71991230010'`);
  const anon = await um(`select count(*)::int n from public.app_codigo_email where telefone = '00000000000' and email is null and nome is null and codigo = '000000'`);
  return { ok: velho.n === 0 && anon.n >= 1, detalhe: JSON.stringify([velho.n, anon.n]) };
});
await caso('desligar a chave volta tudo ao comportamento antigo na hora', async () => {
  await ligar('nao');
  const c = await cad('71991230011'); const p = await rpcAnon('app_codigo_validar', { p_telefone: '71991230011', p_finalidade: 'cadastro', p_codigo: '123456' });
  await ligar('sim');
  return { ok: c.ok === true && p.exigido === false };
});

const falhou = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhou}/${resultados.length} passaram.`);
process.exit(falhou ? 1 : 0);
