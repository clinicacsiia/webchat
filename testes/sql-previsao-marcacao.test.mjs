// FLUXOGRAMA: entrada (clone da produção + supabase/previsao-marcacao-parte1..4.sql; pessoas, marcações da Jornada e telefones INVENTADOS)
//   -> validação (desligado não grava nem responde; código errado; celular inválido; limite de tentativas)
//   -> lógica (carga do #14359 e do #14554 na mesma chave da Jornada; "não sei" e "seguimos" NÃO barram; texto estranho é anotado; conversa nasce com o robô desligado; atendente responde)
//   -> saída (PASS/FAIL por caso) | ROLLBACK: previsao-marcacao-rollback.sql
// Versão 1.0 — 17/11/2026 / Mudança: primeira versão (Webchat de Previsão de marcação). Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
registrar('o retrato da produção monta inteiro', falhas.length === 0, `${falhas.length} falhas`);

const partes = ['parte1-tabelas', 'parte2-paciente', 'parte3-painel', 'parte4-carga'].map((n) => readFileSync(`${REPO}/supabase/previsao-marcacao-${n}.sql`, 'utf8'));
const soQuemAbriu = readFileSync(`${REPO}/supabase/previsao-marcacao-so-quem-abriu.sql`, 'utf8');
await caso('as 4 partes e a mudança "só quem abriu" aplicam duas vezes sem erro (idempotente)', async () => { for (const s of [...partes, soQuemAbriu, ...partes, soQuemAbriu]) await db.exec(s); return { ok: true }; });

const ADM = '00000000-0000-4000-8000-0000000000a1', ATE = '00000000-0000-4000-8000-0000000000a2', MKT = '00000000-0000-4000-8000-0000000000a3';
await db.exec(`
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo') on conflict (chave) do update set valor = excluded.valor;
  insert into auth.users (id, email) values ('${ADM}', 'adm@x.invalid'), ('${ATE}', 'ate@x.invalid'), ('${MKT}', 'mkt@x.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADM}', 'Adm Teste', 'adm@x.invalid', 'admin', true), ('${ATE}', 'Ate Teste', 'ate@x.invalid', 'atendente', true), ('${MKT}', 'Mkt Teste', 'mkt@x.invalid', 'marketing', true);
`);
const ligar = (v) => db.exec(`update public.config set valor = '${v}' where chave = 'previsao_marcacao_modo'`);
const sistema = async () => { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claims', '', false)`); };
const chamar = async (fn, args = [], quem = 'anon') => {
  if (quem === 'anon') await anonimo(); else if (quem === 'sistema') await sistema(); else await como(quem);
  try { return (await q(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) r`, args))[0].r; }
  catch (e) { return { erro: String(e.message) }; } finally { await db.exec('reset role'); }
};

// ---- Jornada inventada: Ana (prontuário 9001) tem uma consulta e um exame abertos; Bia (n:abc) um exame cancelado; Caio (9003) um exame já passado ----
const amanha = new Date(Date.now() + 86400e3).toISOString();
const depois = new Date(Date.now() + 3 * 86400e3).toISOString();
const ontem = new Date(Date.now() - 2 * 86400e3).toISOString();
await db.exec(`
  insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('agendado', 'Agendado', 1, 'agendamento', 'klingo'), ('cancelado', 'Cancelado', 2, 'excecao', 'klingo'), ('atendido', 'Atendido', 3, 'depois', 'klingo') on conflict do nothing;
  insert into public.jornada_paciente (prontuario, nome, fone_chave) values ('9001', 'ANA TESTE', 'x1'), ('n:abc', 'BIA TESTE', 'x2'), ('9003', 'CAIO TESTE', 'x3');
  insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna) values ('9001', (now() + interval '1 day')::date, 'CSI', 'agendado'), ('9001', (now() + interval '3 days')::date, 'DESENVOAR', 'agendado'),
    ('n:abc', (now() + interval '1 day')::date, 'CSI', 'cancelado'), ('9003', (now() - interval '2 days')::date, 'CSI', 'atendido');
`);
const card = async (chave, un) => (await um(`select id from public.jornada_card where paciente_chave = $1 and unidade = $2`, [chave, un])).id;
await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, unidade, agendado_para, status, confirm_status) values
  ($1, 'm1001', 'CONSULTA PEDIATRIA', 'CSI', $4, 'agendado', 'A Confirmar'), ($2, 'm1002', 'ULTRASSONOGRAFIA ABDOME TOTAL', 'DESENVOAR', $5, 'confirmado', 'Confirmado'),
  ($3, 'm1003', 'RESSONANCIA JOELHO', 'CSI', $4, 'cancelado', null)`, [await card('9001', 'CSI'), await card('9001', 'DESENVOAR'), await card('n:abc', 'CSI'), amanha, depois]);
await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, unidade, agendado_para, status) values ($1, 'm1004', 'RAIO X TORAX', 'CSI', $2, 'atendido')`, [await card('9003', 'CSI'), ontem]);

// ---- ajudantes puros ----
await caso('pmarc_classificar entende "não sei", "seguimos", "sim" e "não"', async () => {
  const c = async (t) => (await um(`select public.pmarc_classificar($1) v`, [t])).v;
  const casos = [['Não sei', 'nao_sei'], ['nao sei, seguimos', 'nao_sei'], ['SEGUIMOS', 'nao_sei'], ['pode seguir', 'nao_sei'], ['talvez', 'nao_sei'], ['Sim', 'sim'], ['tá tudo certo', 'sim'], ['ok', 'sim'],
    ['Não', 'nao'], ['está errado', 'nao'], ['não está certo', 'nao'], ['bom dia', null], ['', null]];
  const ruins = []; for (const [t, esp] of casos) { const v = await c(t); if (v !== esp) ruins.push(`${t} -> ${v} (esperado ${esp})`); }
  return { ok: ruins.length === 0, detalhe: ruins.join('; ') };
});
await caso('pmarc_telefone limpa DDI e recusa tamanho errado; pmarc_tipo separa consulta de exame', async () => {
  const t = async (x) => (await um(`select public.pmarc_telefone($1) v`, [x])).v;
  const k = async (x) => (await um(`select public.pmarc_tipo($1) v`, [x])).v;
  const ok = (await t('+55 (71) 98888-7777')) === '71988887777' && (await t('7133334444')) === '7133334444' && (await t('123')) === null && (await t(null)) === null
    && (await k('CONSULTA PEDIATRIA')) === 'consulta' && (await k('Retorno cardiologia')) === 'consulta' && (await k('ULTRASSONOGRAFIA')) === 'exame';
  return { ok };
});

// ---- desligado (nasce assim) ----
await caso('nasce DESLIGADO: a carga não grava e a página responde "desligado"', async () => {
  const modo = (await um(`select valor from public.config where chave = 'previsao_marcacao_modo'`)).valor;
  const lote = await chamar('pmarc_lote', [JSON.stringify([{ p: '9001', n: 'ANA TESTE', c: '71988887777' }])], 'sistema');
  const abrir = await chamar('pmarc_abrir', ['qualquer']);
  const n = Number((await um(`select count(*) n from public.pmarc_pessoa`)).n);
  return { ok: modo === 'nao' && lote.ligada === false && abrir.motivo === 'desligado' && n === 0, detalhe: JSON.stringify({ modo, lote, abrir, n }) };
});
await ligar('sim');

// ---- carga ----
await caso('pmarc_lote registra todo mundo, na mesma chave da Jornada, e é idempotente', async () => {
  const lote = [{ p: '9001', n: 'ANA TESTE', c: '71988887777', t: '', v: 'N' }, { p: 'n:abc', n: 'BIA TESTE', c: '', t: '7133334444', v: 'S' }, { p: '9003', n: 'CAIO TESTE', c: '71977776666' }, { n: 'SEM CHAVE' }];
  const a = await chamar('pmarc_lote', [JSON.stringify(lote)], 'sistema');
  const b = await chamar('pmarc_lote', [JSON.stringify(lote)], 'sistema');
  const n = Number((await um(`select count(*) n from public.pmarc_pessoa`)).n);
  return { ok: a.novas === 3 && a.lidas === 3 && b.novas === 0 && b.alteradas === 0 && n === 3, detalhe: JSON.stringify({ a, b, n }) };
});
await caso('pmarc_enriquecer_lote preenche e-mail, nascimento e "tem CPF" pelo id da marcação, sem apagar nada', async () => {
  const lote = [{ m: '1001', c: '71900000000', t: '', e: 'Ana@Exemplo.Invalid', d: '1990-05-17', k: true }, { m: '1002', e: 'isso-nao-e-email', d: '2999-01-01' }, { m: '99999', e: 'x@y.invalid' }];
  const r = await chamar('pmarc_enriquecer_lote', [JSON.stringify(lote)], 'sistema');
  const ana = await um(`select *, nascimento::text as nasc_txt from public.pmarc_pessoa where chave = '9001'`);
  return { ok: r.achadas === 1 && ana.email === 'ana@exemplo.invalid' && ana.nasc_txt === '1990-05-17' && ana.tem_cpf === true && ana.celular === '71988887777',
    detalhe: JSON.stringify({ r, email: ana.email, nasc: ana.nasc_txt, cel: ana.celular }) };
});

// ---- página: abrir pelo link ----
const codigoDe = async (chave) => (await um(`select codigo from public.pmarc_pessoa where chave = $1`, [chave])).codigo;
await caso('abrir pelo link mostra SÓ as marcações abertas, o aviso de previsão e o que falta; código errado não abre', async () => {
  const v = await chamar('pmarc_abrir', [await codigoDe('9001')]);
  const bia = await chamar('pmarc_abrir', [await codigoDe('n:abc')]);
  const caio = await chamar('pmarc_abrir', [await codigoDe('9003')]);
  const ruim = await chamar('pmarc_abrir', ['codigo-que-nao-existe']);
  const tipos = (v.itens || []).map((i) => i.tipo).join(',');
  return { ok: v.ok === true && v.primeiro_nome === 'Ana' && v.itens.length === 2 && tipos === 'consulta,exame' && /PREVISÃO/.test(v.aviso) && /webchat/.test(v.final) && /WhatsApp/.test(v.final) && /telefone/.test(v.final)
    && v.faltam.includes('cpf') === false && v.faltam.includes('email') === false && bia.itens.length === 0 && caio.itens.length === 0 && ruim.motivo === 'codigo_invalido' && v.conversa === null,
    detalhe: JSON.stringify({ itens: v.itens?.length, tipos, faltam: v.faltam, bia: bia.itens?.length, caio: caio.itens?.length, ruim }) };
});
await caso('o link não cria contato nem conversa: só responder ou escrever cria', async () => {
  const c = Number((await um(`select count(*) n from public.contatos where origem = 'previsao'`)).n);
  const v = Number((await um(`select count(*) n from public.conversas c join public.contatos t on t.id = c.contato_id where t.origem = 'previsao'`)).n);
  return { ok: c === 0 && v === 0, detalhe: `${c} contatos, ${v} conversas` };
});

// ---- achar sem o link ----
await caso('celular + nascimento acham a previsão; errado não acha; 8 erros travam sem entregar nada', async () => {
  const certo = await chamar('pmarc_identificar', ['(71) 98888-7777', '1990-05-17']);
  const errado = await chamar('pmarc_identificar', ['71988887777', '1991-01-01']);
  const invalido = await chamar('pmarc_identificar', ['123', '1990-05-17']);
  let ultimo; for (let i = 0; i < 8; i++) ultimo = await chamar('pmarc_identificar', ['71955554444', `1980-01-0${(i % 9) + 1}`]);
  const travado = await chamar('pmarc_identificar', ['71955554444', '1980-02-02']);
  return { ok: certo.achou === true && certo.pessoas.length === 1 && certo.pessoas[0].primeiro_nome === 'Ana' && errado.achou === false && !('pessoas' in errado) && invalido.motivo === 'celular_invalido'
      && travado.motivo === 'muitas_tentativas', detalhe: JSON.stringify({ certo: certo.achou, errado, invalido, travado }) };
});

// ---- responder: nunca barra ----
let ANA;
await caso('"Não sei" vale como resposta: anota, abre a conversa com a equipe e avisa que será visto e confirmado por webchat, WhatsApp e telefone', async () => {
  ANA = await codigoDe('9001');
  const r = await chamar('pmarc_responder', [ANA, JSON.stringify({ resposta: 'nao_sei' })]);
  const p = await um(`select resposta, respondeu_em, aceitou_lgpd_em, conversa_id from public.pmarc_pessoa where chave = '9001'`);
  const msgs = await q(`select autor, texto from public.mensagens where conversa_id = $1 order by id`, [p.conversa_id]);
  const conv = await um(`select status, ia_ativa, motor, agente_id, triagem_resumo, cliente_aguarda_desde from public.conversas where id = $1`, [p.conversa_id]);
  const ct = await um(`select t.origem, t.telefone, t.aceitou_lgpd_em from public.contatos t join public.conversas c on c.contato_id = t.id where c.id = $1`, [p.conversa_id]);
  return { ok: r.ok === true && r.resposta === 'nao_sei' && !!r.conversa?.token && p.resposta === 'nao_sei' && !!p.respondeu_em && !!p.aceitou_lgpd_em
      && msgs.length === 2 && msgs[0].autor === 'cliente' && /não sabe/.test(msgs[0].texto) && msgs[1].autor === 'agente' && /webchat.*WhatsApp.*telefone/s.test(msgs[1].texto)
      && conv.status === 'aguardando' && conv.ia_ativa === false && conv.agente_id === null && /PREVISÃO DE MARCAÇÃO/.test(conv.triagem_resumo) && /não sei/.test(conv.triagem_resumo) && !!conv.cliente_aguarda_desde
      && ct.origem === 'previsao' && ct.telefone === '71988887777',
    detalhe: JSON.stringify({ r: r.ok, resp: p.resposta, msgs: msgs.length, conv: [conv.status, conv.ia_ativa], ct }) };
});
await caso('o robô do chat NÃO responde nessa conversa e a mensagem do paciente fica à espera da atendente', async () => {
  const conv = (await um(`select conversa_id from public.pmarc_pessoa where chave = '9001'`)).conversa_id;
  const antes = Number((await um(`select count(*) n from public.mensagens where conversa_id = $1`, [conv])).n);
  const e = await chamar('pmarc_enviar', [ANA, 'Bom dia, preciso mudar o horário']);
  const depoisN = Number((await um(`select count(*) n from public.mensagens where conversa_id = $1`, [conv])).n);
  const ev = Number((await um(`select count(*) n from public.fluxo_evento where conversa_id = $1`, [conv])).n);
  return { ok: e.ok === true && depoisN === antes + 1 && ev === 0, detalhe: JSON.stringify({ antes, depoisN, fluxo_evento: ev }) };
});
await caso('texto estranho NÃO barra: e-mail, CPF e celular errados são anotados e marcados para revisão', async () => {
  const r = await chamar('pmarc_responder', [ANA, JSON.stringify({ texto: 'seguimos', email: 'sem-arroba', cpf: '123', celular: '99', observacao: 'Prefiro de manhã', nascimento: 'ontem' })]);
  const p = await um(`select informado, resposta from public.pmarc_pessoa where chave = '9001'`);
  const i = p.informado;
  return { ok: r.ok === true && p.resposta === 'nao_sei' && i.email === 'sem-arroba' && i.email_revisar === true && i.cpf === '123' && i.cpf_revisar === true && i.celular_revisar === true && i.observacao === 'Prefiro de manhã' && i.nascimento_revisar === true,
    detalhe: JSON.stringify(i) };
});
await caso('o aviso final vai uma vez só (não repete a cada resposta)', async () => {
  const conv = (await um(`select conversa_id from public.pmarc_pessoa where chave = '9001'`)).conversa_id;
  const n = Number((await um(`select count(*) n from public.mensagens where conversa_id = $1 and autor = 'agente' and texto like '%vista e confirmada%'`, [conv])).n);
  return { ok: n === 1, detalhe: `${n} avisos` };
});
await caso('quem escreve "não sei" no chat também conta como resposta, mesmo sem apertar botão', async () => {
  const codigo = await codigoDe('9003');
  await db.exec(`update public.pmarc_pessoa set celular = '71977776666' where chave = '9003'`);
  const e = await chamar('pmarc_enviar', [codigo, 'não sei, pode seguir']);
  const p = await um(`select resposta from public.pmarc_pessoa where chave = '9003'`);
  return { ok: e.ok === true && p.resposta === 'nao_sei', detalhe: JSON.stringify({ e, resp: p.resposta }) };
});
await caso('sem nenhum celular a resposta é guardada e a página só pede o celular (nada é barrado)', async () => {
  const bia = await codigoDe('n:abc');
  await db.exec(`update public.pmarc_pessoa set telefone = null, celular = null where chave = 'n:abc'`);
  const r = await chamar('pmarc_responder', [bia, JSON.stringify({ resposta: 'sim' })]);
  const e = await chamar('pmarc_enviar', [bia, 'oi']);
  const p = await um(`select resposta, conversa_id from public.pmarc_pessoa where chave = 'n:abc'`);
  const r2 = await chamar('pmarc_responder', [bia, JSON.stringify({ celular: '(71) 96666-5555' })]);
  const p2 = await um(`select conversa_id from public.pmarc_pessoa where chave = 'n:abc'`);
  return { ok: r.ok === true && r.sem_celular === true && p.resposta === 'sim' && p.conversa_id === null && e.motivo === 'sem_celular' && r2.sem_celular === false && !!p2.conversa_id,
    detalhe: JSON.stringify({ r: r.sem_celular, e: e.motivo, r2: r2.sem_celular }) };
});

// ---- atendente responde, paciente vê ----
await caso('a atendente responde no painel e o paciente recebe pela pmarc_mensagens (sem repetir)', async () => {
  const conv = (await um(`select conversa_id from public.pmarc_pessoa where chave = '9001'`)).conversa_id;
  const todas = await chamar('pmarc_mensagens', [ANA, 0]);
  const ultimo = todas.mensagens[todas.mensagens.length - 1].id;
  await como(ATE);
  await q(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, 'agente', $2, 'Oi Ana, vimos a sua previsão. Pode ser sexta?')`, [conv, ATE]);
  await db.exec('reset role');
  const novas = await chamar('pmarc_mensagens', [ANA, ultimo]);
  const vazias = await chamar('pmarc_mensagens', [ANA, novas.mensagens[0]?.id ?? 0]);
  return { ok: todas.mensagens.length >= 4 && novas.mensagens.length === 1 && novas.mensagens[0].autor === 'agente' && novas.mensagens[0].agente === 'Ate Teste' && vazias.mensagens.length === 0,
    detalhe: JSON.stringify({ total: todas.mensagens.length, novas: novas.mensagens.length, vazias: vazias.mensagens.length }) };
});
await caso('conversa encerrada reabre quando o paciente escreve, sem religar o robô e sem perder o resumo', async () => {
  const conv = (await um(`select conversa_id from public.pmarc_pessoa where chave = '9001'`)).conversa_id;
  await db.query(`update public.conversas set motivo_encerramento = 'nao_respondido', status = 'encerrada' where id = $1`, [conv]);
  const e = await chamar('pmarc_enviar', [ANA, 'voltei']);
  const c = await um(`select status, ia_ativa, triagem_resumo from public.conversas where id = $1`, [conv]);
  return { ok: e.ok === true && c.status === 'aguardando' && c.ia_ativa === false && /PREVISÃO DE MARCAÇÃO/.test(c.triagem_resumo || ''), detalhe: JSON.stringify(c) };
});

// ---- espontâneo ----
await caso('quem não achou a previsão entra assim mesmo (pré-cadastro espontâneo), uma vez por celular', async () => {
  const a = await chamar('pmarc_novo', ['Dora Teste', '(71) 95555-4444', '1985-03-02', 'Marquei por telefone ontem']);
  const b = await chamar('pmarc_novo', ['Dora Teste', '71955554444']);
  const sem = await chamar('pmarc_novo', ['', '12']);
  const n = Number((await um(`select count(*) n from public.pmarc_pessoa where origem = 'espontaneo'`)).n);
  const r = await chamar('pmarc_responder', [a.codigo, JSON.stringify({ resposta: 'nao_sei' })]);
  return { ok: a.ok === true && a.itens.length === 0 && b.codigo === a.codigo && sem.motivo === 'celular_invalido' && n === 1 && r.ok === true && !!r.conversa?.token, detalhe: JSON.stringify({ a: a.ok, igual: b.codigo === a.codigo, sem: sem.motivo, n }) };
});

// ---- painel ----
await caso('painel: só admin e atendente (marketing, paciente e anônimo não entram)', async () => {
  const mkt = await chamar('painel_pmarc_lista', ['todos', null, 50, 0], MKT);
  const anon = await chamar('painel_pmarc_lista', ['todos', null, 50, 0], 'anon');
  const ate = await chamar('painel_pmarc_lista', ['todos', null, 50, 0], ATE);
  const adm = await chamar('painel_pmarc_resumo', [], ADM);
  return { ok: /Só a equipe/.test(mkt.erro || '') && !!anon.erro && Array.isArray(ate) && adm.ligado === true, detalhe: JSON.stringify({ mkt: mkt.erro, anon: anon.erro?.slice(0, 40), ate: Array.isArray(ate) }) };
});
await caso('painel: lista os que têm marcação aberta (Ana), os espontâneos e quem tem conversa; mais urgente primeiro; busca por nome e celular; filtros', async () => {
  const todos = await chamar('painel_pmarc_lista', ['todos', null, 50, 0], ATE);
  const nomes = todos.map((x) => x.nome);
  const ana = todos.find((x) => x.nome === 'ANA TESTE');
  const busca = await chamar('painel_pmarc_lista', ['todos', 'dora', 50, 0], ATE);
  const porCel = await chamar('painel_pmarc_lista', ['todos', '8888-7777', 50, 0], ATE);
  const nsei = await chamar('painel_pmarc_lista', ['nao_sei', null, 50, 0], ATE);
  const conv = await chamar('painel_pmarc_lista', ['conversa', null, 50, 0], ATE);
  const res = await chamar('painel_pmarc_resumo', [], ATE);
  return { ok: !!ana && ana.n_itens === 2 && ana.itens[0].tipo === 'consulta' && ana.resposta === 'nao_sei' && !!ana.codigo && ana.revisar === true && nomes[0] === 'ANA TESTE'
      && nomes.includes('Dora Teste') && nomes.includes('CAIO TESTE') && busca.length === 1 && porCel.length === 1 && nsei.length >= 2 && conv.length >= 3 && res.total >= 4 && res.com_conversa >= 3 && res.responderam >= 3,
    detalhe: JSON.stringify({ nomes, busca: busca.length, porCel: porCel.length, nsei: nsei.length, conv: conv.length, res }) };
});
await caso('painel: marcar link enviado; abrir conversa cria uma conversa já com a atendente e sem ninguém "esperando"', async () => {
  const eu = await um(`select id from public.pmarc_pessoa where origem = 'klingo' and conversa_id is null and chave = '9003'`).catch(() => null);
  // Caio já tem conversa; usa uma pessoa nova sem conversa
  await chamar('pmarc_lote', [JSON.stringify([{ p: '9004', n: 'EVA TESTE', c: '71944443333' }])], 'sistema');
  const evaId = (await um(`select id from public.pmarc_pessoa where chave = '9004'`)).id;
  const enviado = await chamar('painel_pmarc_link_enviado', [evaId], ATE);
  const conv = await chamar('painel_pmarc_conversa', [evaId], ATE);
  const c = await um(`select status, agente_id, ia_ativa, cliente_aguarda_desde from public.conversas where id = $1`, [conv]);
  const outra = await chamar('painel_pmarc_conversa', [evaId], ADM);
  const mkt = await chamar('painel_pmarc_conversa', [evaId], MKT);
  const p = await um(`select link_enviado_em, link_enviado_por from public.pmarc_pessoa where id = $1`, [evaId]);
  return { ok: enviado === 1 && typeof conv === 'string' && c.status === 'em_atendimento' && c.agente_id === ATE && c.ia_ativa === false && c.cliente_aguarda_desde === null && outra === conv
      && /Só a equipe/.test(mkt.erro || '') && !!p.link_enviado_em && p.link_enviado_por === ATE, detalhe: JSON.stringify({ enviado, c, mkt: mkt.erro }) };
});
await caso('painel: sem celular não abre conversa e explica', async () => {
  await chamar('pmarc_lote', [JSON.stringify([{ p: '9005', n: 'FÁBIO TESTE' }])], 'sistema');
  await db.query(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna) values ('9005', (now() + interval '1 day')::date, 'CSI', 'agendado')`);
  await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, unidade, agendado_para, status) values ($1, 'm1005', 'ECOCARDIOGRAMA', 'CSI', $2, 'agendado')`, [await card('9005', 'CSI'), amanha]);
  const id = (await um(`select id from public.pmarc_pessoa where chave = '9005'`)).id;
  const r = await chamar('painel_pmarc_conversa', [id], ATE);
  const antes = await chamar('painel_pmarc_lista', ['todos', 'fábio', 50, 0], ATE);
  const codigo = (await um(`select codigo from public.pmarc_pessoa where id = $1`, [id])).codigo;
  await chamar('pmarc_abrir', [codigo]);
  const lista = await chamar('painel_pmarc_lista', ['todos', 'fábio', 50, 0], ATE);
  return { ok: /Sem celular/.test(r.erro || '') && antes.length === 0 && lista.length === 1 && lista[0].celular === null, detalhe: JSON.stringify({ r: r.erro, antes: antes.length, n: lista.length }) };
});
await caso('painel: quem só foi registrado pelo Klingo e nunca abriu NÃO aparece na lista nem no resumo; ao abrir o link passa a aparecer', async () => {
  await chamar('pmarc_lote', [JSON.stringify([{ p: '9006', n: 'GIL TESTE', c: '71933332222' }])], 'sistema');
  await db.query(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna) values ('9006', (now() + interval '1 day')::date, 'CSI', 'agendado')`);
  await db.query(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, unidade, agendado_para, status) values ($1, 'm1006', 'TOMOGRAFIA CRANIO', 'CSI', $2, 'agendado')`, [await card('9006', 'CSI'), amanha]);
  const nome = async (f) => (await chamar('painel_pmarc_lista', [f, 'gil', 50, 0], ATE)).length;
  const todosAntes = await chamar('painel_pmarc_lista', ['todos', null, 200, 0], ATE);
  const resAntes = await chamar('painel_pmarc_resumo', [], ATE);
  const cadastrados = Number((await um(`select count(*) n from public.pmarc_pessoa`)).n);
  const antes = await nome('todos');
  const codigo = (await um(`select codigo from public.pmarc_pessoa where chave = '9006'`)).codigo;
  await chamar('pmarc_abrir', [codigo]);
  const depois = await nome('todos');
  const resDepois = await chamar('painel_pmarc_resumo', [], ATE);
  const gil = (await chamar('painel_pmarc_lista', ['todos', 'gil', 50, 0], ATE))[0];
  const ainda = await um(`select count(*) n from public.pmarc_pessoa where chave = '9006'`);
  return { ok: antes === 0 && depois === 1 && gil.n_itens === 1 && gil.primeiro_acesso_em && Number(ainda.n) === 1 && resDepois.total === resAntes.total + 1 && resAntes.total < cadastrados && todosAntes.length === resAntes.total && resDepois.abriram === resAntes.abriram + 1,
    detalhe: JSON.stringify({ antes, depois, resAntes: resAntes.total, resDepois: resDepois.total, cadastrados, lista: todosAntes.length }) };
});

// ---- permissões: o público não lê tabela nenhuma ----
await caso('o público (anon e logado) não lê nem escreve nas tabelas da previsão e não chama as funções internas', async () => {
  const falhou = async (sql) => { await anonimo(); try { await db.query(sql); return false; } catch { return true; } finally { await db.exec('reset role'); } };
  const t1 = await falhou(`select * from public.pmarc_pessoa`);
  const t2 = await falhou(`select * from public.pmarc_tentativa`);
  const t3 = await falhou(`insert into public.pmarc_pessoa (chave) values ('x')`);
  const f1 = await falhou(`select public.pmarc_lote('[]'::jsonb)`);
  const f2 = await falhou(`select public.pmarc_conversa_garantir(gen_random_uuid())`);
  const f3 = await falhou(`select public.pmarc_disparar('rapido')`);
  const f4 = await falhou(`select public.painel_pmarc_resumo()`);
  return { ok: t1 && t2 && t3 && f1 && f2 && f3 && f4, detalhe: JSON.stringify({ t1, t2, t3, f1, f2, f3, f4 }) };
});

// ---- rotina ----
await caso('a rotina: desligada não faz nada; ligada chama a Edge Function (completo na 1ª vez, rápido depois)', async () => {
  await ligar('nao'); const off = await chamar('pmarc_vigiar', [], 'sistema'); await ligar('sim');
  const a = await chamar('pmarc_vigiar', [], 'sistema');
  await db.exec(`update public.pmarc_estado set tentativa_em = now() - interval '10 minutes'`);
  await chamar('pmarc_estado_gravar', ['completo', JSON.stringify({ ok: true }), null], 'sistema');
  await db.exec(`update public.pmarc_estado set tentativa_em = now() - interval '10 minutes'`);
  const b = await chamar('pmarc_vigiar', [], 'sistema');
  const ch = await q(`select url, body from net.chamadas order by id`);
  const cron = await q(`select jobname, schedule from cron.job where jobname = 'pmarc-cadastrar'`);
  return { ok: off === 'desligada' && a === 'completo' && b === 'rapido' && ch.length === 2 && /pmarc-cadastrar/.test(ch[0].url) && ch[1].body.modo === 'rapido' && cron.length === 1 && cron[0].schedule === '*/10 * * * *',
    detalhe: JSON.stringify({ off, a, b, chamadas: ch.length, cron }) };
});

// ---- o resto do sistema não mudou ----
await caso('não mexe no chat: nenhuma conversa de previsão tem passo do robô e o Klingo não foi chamado', async () => {
  const f = Number((await um(`select count(*) n from public.conversa_fluxo cf join public.pmarc_pessoa p on p.conversa_id = cf.conversa_id`)).n);
  const ops = Number((await um(`select count(*) n from public.klingo_operacao`)).n);
  return { ok: f === 0 && ops === 0, detalhe: `${f} fluxos, ${ops} operações` };
});

const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} casos passaram`);
process.exit(falhasN ? 1 : 0);
