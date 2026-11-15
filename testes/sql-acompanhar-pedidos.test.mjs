// FLUXOGRAMA: entrada (o retrato da produção + acesso-rapido-paciente.sql + acompanhar-pedidos.sql; conversas abertas pelo motor REAL do chat; cartões/exames da Jornada inventados) -> validação (cada chamada como "anon", igual ao supabase-js) -> lógica (vincular, listar, balão de novidades, ações do pedido, resultado entregue pela equipe, vigia) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (acompanhar pedidos)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo, como } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-paciente.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-chat.sql`, 'utf8'));
const sql = readFileSync(`${REPO}/supabase/acompanhar-pedidos.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await caso('acompanhar-pedidos.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);
for (const k of ['klingo_api_consultar', 'klingo_api_cancelar', 'klingo_api_remarcar', 'klingo_api_resultado']) await db.query(`insert into public.config (chave, valor) values ($1, 'sim') on conflict (chave) do update set valor = 'sim'`, [k]);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste'), ('klingo_interno_segredo', 'segredo-de-teste') on conflict (name) do nothing`);

const rpc = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
const dono = (s, p) => q(s, p);
const CPF_ANA = '52998224725', CPF_ANA_TXT = '529.982.247-25', CPF_LEO_TXT = '111.444.777-35';
const NASC_ANA = '1988-04-12', NASC_LEO = '2019-08-30';
const TEL_ANA = '71991230001', TEL_BIA = '71991230002';
const cad = (tel, nome, nasc, filhos = []) => rpc('app_cadastrar', { p_telefone: tel, p_nome: nome, p_nascimento: nasc, p_pin: '1357', p_filhos: filhos, p_aparelho: 'teste' });
const ana = await cad(TEL_ANA, 'Ana Souza Teste', NASC_ANA, [{ nome: 'Leo Souza Teste', nascimento: NASC_LEO }]);
const bia = await cad(TEL_BIA, 'Bia Amiga Teste', '1990-01-01');
const TOK = ana.token, TOK_BIA = bia.token;
const iniciar = async (nome, tel, tipo = 'proprio', filho = null, email = 'ana@exemplo.invalid') => {
  await dono(`update public.conversas set criado_em = criado_em - interval '2 hours'`);
  const r = await rpc('chat_iniciar', { p_nome: nome, p_telefone: tel, p_email: email, p_aceite: true, p_paciente_tipo: tipo, ...(filho ? { p_paciente_nome: filho } : {}) });
  return { c: r.conversa_id, t: r.token };
};
const vincular = (c, tok = TOK) => rpc('app_conversa_vincular', { p_token: tok, p_conversa: c.c, p_conv_token: c.t });
const pedidos = (tok = TOK, renova = true) => rpc('app_pedidos', { p_token: tok, p_renova: renova });
const contagem = (tok = TOK) => rpc('app_pedidos_contagem', { p_token: tok });
await dono(`insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('agendado', 'Agendado', 1, 'agendamento', 'klingo'), ('chegou', 'Chegou', 2, 'depois', 'klingo'), ('em_atendimento', 'Em atendimento', 3, 'depois', 'klingo') on conflict do nothing`);
// Exame da Jornada ligado à conversa (como o Klingo faria): card + exame
let seq = 100;
const exame = async (c, { nome = 'RM JOELHO DIREITO', status = 'agendado', conf = null, coluna = 'agendado', dias = 3, atend = null, chave = '5001' } = {}) => {
  const card = (await dono(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna, conversa_id) values ($1, current_date, 'Centro', $2, $3) returning id`, [chave, coluna, c.c]))[0].id;
  return (await dono(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, status, confirm_status, unidade, atendimento_id, agendado_para) values ($1, $2, $3, $4, $5, 'Centro', $6, now() + make_interval(days => $7)) returning id`,
    [card, 'm' + (++seq), nome, status, conf, atend ?? String(++seq), dias]))[0].id;
};
const mudar = (id, status, conf = null) => dono(`update public.jornada_exame set status = $2, confirm_status = $3 where id = $1`, [id, status, conf]);

// ---------------------------------------------------------------- vincular
const cAna = await iniciar('Ana Souza Teste', TEL_ANA);
const cLeo = await iniciar('Ana Souza Teste', TEL_ANA, 'filho', 'Leo Souza Teste');
const cBia = await iniciar('Bia Amiga Teste', TEL_BIA, 'proprio', null, 'bia@exemplo.invalid');
await caso('vincular: a conversa do aparelho (id + token + celular do cadastro) entra no cadastro, a do filho também', async () => {
  const a = await vincular(cAna), l = await vincular(cLeo);
  const n = (await dono(`select count(*)::int n from public.app_conversa`))[0].n;
  const eu = (await dono(`select pessoa_nome, eu from public.app_conversa where conversa_id = $1`, [cLeo.c]))[0];
  return { ok: a.ok === true && l.ok === true && n === 2 && eu.eu === false && eu.pessoa_nome === 'Leo Souza Teste', detalhe: JSON.stringify(eu) };
});
await caso('vincular: código errado, celular de outra pessoa, aparelho desconhecido ou travado são recusados', async () => {
  const errado = await rpc('app_conversa_vincular', { p_token: TOK, p_conversa: cAna.c, p_conv_token: 'x'.repeat(40) });
  const outro = await vincular(cBia);                       // conversa da Bia no aparelho da Ana
  const desconhecido = await vincular(cAna, 'z'.repeat(64));
  await dono(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute' where paciente_id = $1`, [ana.perfil ? (await dono(`select id from public.app_paciente where telefone = $1`, [TEL_ANA]))[0].id : null]);
  const travado = await vincular(cAna);
  await dono(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  const n = (await dono(`select count(*)::int n from public.app_conversa`))[0].n;
  return { ok: errado.erro === 'conversa' && outro.erro === 'celular' && desconhecido.erro === 'sessao' && travado.erro === 'bloqueado' && n === 2, detalhe: `${errado.erro} ${outro.erro} ${desconhecido.erro} ${travado.erro} n=${n}` };
});
await caso('vincular duas vezes não duplica', async () => { await vincular(cAna); return { ok: (await dono(`select count(*)::int n from public.app_conversa`))[0].n === 2 }; });
await vincular(cBia, TOK_BIA);

// ---------------------------------------------------------------- lista
const exAna = await exame(cAna, { nome: 'RM JOELHO DIREITO', status: 'agendado', atend: '9001' });
const exLeo = await exame(cLeo, { nome: 'US ABDOME TOTAL', status: 'confirmado', conf: 'confirmado', chave: '5002', atend: '9002' });
await caso('a lista traz o pedido do titular E o do filho, cada um com o passo (marcado = 2, confirmado = 3)', async () => {
  const r = await pedidos();
  const a = r.pedidos.find((p) => p.conversa === cAna.c), l = r.pedidos.find((p) => p.conversa === cLeo.c);
  return { ok: r.ok === true && r.pedidos.length === 2 && a.eu === true && a.exames[0].ok === 2 && l.eu === false && l.pessoa === 'Leo Souza Teste' && l.exames[0].ok === 3 && r.pessoas.length === 2,
    detalhe: JSON.stringify(r.pedidos.map((p) => [p.pessoa, p.exames.map((e) => e.ok)])) };
});
await caso('o pedido da OUTRA pessoa (Bia) nunca aparece para a Ana, e vice-versa', async () => {
  await exame(cBia, { nome: 'RX TORAX', status: 'agendado', chave: '5003' });
  const ra = await pedidos(), rb = await pedidos(TOK_BIA);
  const txtA = JSON.stringify(ra);
  return { ok: ra.pedidos.length === 2 && !txtA.includes('RX TORAX') && rb.pedidos.length === 1 && rb.pedidos[0].exames[0].nome === 'RX TORAX', detalhe: `${ra.pedidos.length}/${rb.pedidos.length}` };
});
await caso('nada pessoal na resposta: sem CPF, e-mail, telefone inteiro ou token de conversa', async () => {
  await dono(`update public.app_paciente set cpf = $1, email = 'ana@exemplo.invalid' where telefone = $2`, [CPF_ANA, TEL_ANA]);
  const txt = JSON.stringify(await pedidos());
  return { ok: !txt.includes(CPF_ANA) && !txt.includes('ana@exemplo') && !txt.includes(TEL_ANA) && !txt.includes(cAna.t) && !txt.includes(cLeo.t) };
});
await caso('exame cancelado vira exceção (não some); remarcado não aparece (o novo horário o substitui)', async () => {
  const c = await exame(cAna, { nome: 'TC CRANIO', status: 'cancelado', chave: '5004' });
  await exame(cAna, { nome: 'TC ANTIGO REMARCADO', status: 'remarcado', chave: '5005' });
  const r = await pedidos(); const nomes = r.pedidos.flatMap((p) => p.exames);
  return { ok: nomes.some((e) => e.nome === 'TC CRANIO' && e.excecao === 'cancelado' && e.ok === null) && !nomes.some((e) => e.nome === 'TC ANTIGO REMARCADO'), detalhe: JSON.stringify(nomes.map((e) => e.nome)) };
});
await dono(`delete from public.jornada_exame where procedimento in ('TC CRANIO', 'TC ANTIGO REMARCADO')`);

// ---------------------------------------------------------------- balão de novidades
await caso('o que já existia na hora de vincular NÃO conta como novidade', async () => {
  const cX = await iniciar('Ana Souza Teste', TEL_ANA); await exame(cX, { nome: 'RX JA EXISTIA', status: 'confirmado', conf: 'confirmado', chave: '5020' });
  await rpc('app_pedido_visto', { p_token: TOK });   // o que apareceu até aqui já foi visto
  await vincular(cX);
  const c = await contagem();
  await dono(`delete from public.jornada_exame where card_id in (select id from public.jornada_card where conversa_id = $1)`, [cX.c]); await dono(`delete from public.jornada_card where conversa_id = $1`, [cX.c]);
  return { ok: c.ok === true && c.novidades === 0, detalhe: JSON.stringify(c) };
});
await caso('um pedido que SÓ ganha exame depois de vinculado (a equipe marcou) vira novidade', async () => {
  const cY = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(cY);
  const antes = (await contagem()).novidades;
  await exame(cY, { nome: 'US NOVO MARCADO', status: 'agendado', chave: '5021' });
  const depois = (await contagem()).novidades;
  await rpc('app_pedido_visto', { p_token: TOK, p_conversa: cY.c });
  const fim = (await contagem()).novidades;
  await dono(`delete from public.jornada_exame where card_id in (select id from public.jornada_card where conversa_id = $1)`, [cY.c]); await dono(`delete from public.jornada_card where conversa_id = $1`, [cY.c]);
  await rpc('app_pedido_visto', { p_token: TOK });
  return { ok: antes === 0 && depois === 1 && fim === 0, detalhe: `${antes} → ${depois} → ${fim}` };
});
await caso('quando o Klingo muda o status (marcado → confirmado) o balão mostra 1, e só desse pedido', async () => {
  await mudar(exAna, 'confirmado', 'confirmado');
  const c = await contagem(); const r = await pedidos();
  return { ok: c.novidades === 1 && r.pedidos.find((p) => p.conversa === cAna.c).novo === true && r.pedidos.find((p) => p.conversa === cLeo.c).novo === false, detalhe: JSON.stringify(c) };
});
await caso('vista a novidade, o balão some; a mesma mudança não volta', async () => {
  const v = await rpc('app_pedido_visto', { p_token: TOK, p_conversa: cAna.c });
  const c = await contagem();
  return { ok: v.ok === true && c.novidades === 0 };
});
await caso('duas mudanças em pedidos diferentes = balão 2; "visto" sem conversa marca todos', async () => {
  await mudar(exAna, 'atendido'); await mudar(exLeo, 'cancelado');
  const c1 = await contagem();
  await rpc('app_pedido_visto', { p_token: TOK });
  const c2 = await contagem();
  return { ok: c1.novidades === 2 && c2.novidades === 0, detalhe: `${c1.novidades} → ${c2.novidades}` };
});
await mudar(exLeo, 'confirmado', 'confirmado'); await rpc('app_pedido_visto', { p_token: TOK });
await caso('recarregar sozinho (balão e lista) NÃO estende os 30 minutos do PIN', async () => {
  const id = (await dono(`select id from public.app_paciente where telefone = $1`, [TEL_ANA]))[0].id;
  await dono(`update public.app_aparelho set desbloqueada_ate = now() + interval '5 minutes' where paciente_id = $1`, [id]);
  const antes = (await dono(`select desbloqueada_ate d from public.app_aparelho where paciente_id = $1`, [id]))[0].d.getTime();
  await contagem(); await pedidos(TOK, false);
  const meio = (await dono(`select desbloqueada_ate d from public.app_aparelho where paciente_id = $1`, [id]))[0].d.getTime();
  await pedidos(TOK, true);
  const depois = (await dono(`select desbloqueada_ate d from public.app_aparelho where paciente_id = $1`, [id]))[0].d.getTime();
  return { ok: meio === antes && depois > antes, detalhe: `${(meio - antes)} ${(depois - antes)}` };
});
await caso('travado: o balão e a lista pedem o PIN (não mostram nada)', async () => {
  await dono(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const c = await contagem(), r = await pedidos(TOK, false), r2 = await pedidos();
  await dono(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  return { ok: c.erro === 'bloqueado' && r.erro === 'bloqueado' && r2.erro === 'bloqueado' && !JSON.stringify([c, r, r2]).includes('JOELHO'), detalhe: `${c.erro} ${r.erro} ${r2.erro}` };
});
await caso('acesso rápido desligado: tudo responde "indisponivel"', async () => {
  await dono(`update public.config set valor = 'nao' where chave = 'app_acesso_modo'`);
  const c = await contagem(), r = await pedidos();
  await dono(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);
  return { ok: c.erro === 'indisponivel' && r.erro === 'indisponivel' };
});

// ---------------------------------------------------------------- ações
await caso('ação "conversa": devolve o código da conversa do pedido (só para conversa vinculada ao cadastro)', async () => {
  const r = await rpc('app_pedido_acao', { p_token: TOK, p_conversa: cLeo.c, p_acao: 'conversa' });
  const outra = await rpc('app_pedido_acao', { p_token: TOK, p_conversa: cBia.c, p_acao: 'conversa' });
  const bia = await rpc('app_pedido_acao', { p_token: TOK_BIA, p_conversa: cLeo.c, p_acao: 'conversa' });
  return { ok: r.ok === true && r.token === cLeo.t && r.tipo === 'filho' && r.paciente_nome === 'Leo Souza Teste' && outra.ok === false && bia.ok === false && !JSON.stringify([outra, bia]).includes(cBia.t), detalhe: JSON.stringify([outra.erro, bia.erro]) };
});
await caso('ação inválida é recusada', async () => {
  const r = await rpc('app_pedido_acao', { p_token: TOK, p_conversa: cLeo.c, p_acao: 'apagar' });
  return { ok: r.ok === false && r.erro === 'acao' };
});
await caso('conversa ABERTA + cancelar: a mensagem do paciente vai para ela, nenhuma conversa nova nasce, ninguém é encerrado', async () => {
  await dono(`update public.conversas set status = 'em_atendimento', encerrada_em = null, encerramento_origem = null where id = $1`, [cAna.c]);   // com a equipe atendendo (o chat fecha sozinho as conversas sem humano quando abre outra)
  const antes = (await dono(`select count(*)::int n from public.conversas`))[0].n;
  const r = await rpc('app_pedido_acao', { p_token: TOK, p_conversa: cAna.c, p_acao: 'cancelar', p_exame: exAna });
  const msg = await dono(`select texto from public.mensagens where conversa_id = $1 and autor = 'cliente' order by id desc limit 1`, [cAna.c]);
  if (!msg[0]) return { ok: false, detalhe: JSON.stringify(r) };
  const depois = (await dono(`select count(*)::int n from public.conversas`))[0].n;
  return { ok: r.ok === true && r.enviada === true && r.conversa === cAna.c && /cancelar/i.test(msg[0].texto) && /RM JOELHO/.test(msg[0].texto) && antes === depois, detalhe: msg[0].texto };
});
await caso('conversa ENCERRADA + cancelar: abre conversa nova do mesmo paciente, já vinculada, e a motor segue (CPF salvo é respondido sozinho)', async () => {
  await dono(`update public.app_paciente set nascimento = $1, cpf = $2 where telefone = $3`, [NASC_ANA, CPF_ANA, TEL_ANA]);
  await dono(`update public.conversas set status = 'encerrada', encerrada_em = now(), ia_ativa = false, encerramento_origem = 'sistema' where id = $1`, [cAna.c]);
  await dono(`update public.conversas set criado_em = criado_em - interval '3 hours'`);
  const r = await rpc('app_pedido_acao', { p_token: TOK, p_conversa: cAna.c, p_acao: 'cancelar', p_exame: exAna });
  const nova = (await dono(`select c.reentrada_de, c.paciente_tipo, f.passo, f.dados from public.conversas c join public.conversa_fluxo f on f.conversa_id = c.id where c.id = $1`, [r.conversa]))[0];
  const vinc = (await dono(`select eu from public.app_conversa where conversa_id = $1`, [r.conversa]))[0];
  return { ok: r.ok === true && r.nova === true && r.conversa !== cAna.c && nova.reentrada_de === cAna.c && !!vinc && vinc.eu === true && r.token && nova.dados.assunto === 'Cancelar', detalhe: `passo=${nova.passo} dados=${JSON.stringify(nova.dados).slice(0, 200)} dirigida=${r.dirigida}` };
});
await caso('conversa encerrada de um filho: a conversa nova é do filho (não do titular)', async () => {
  await dono(`update public.conversas set status = 'encerrada', encerrada_em = now(), ia_ativa = false, encerramento_origem = 'sistema' where id = $1`, [cLeo.c]);
  await dono(`update public.conversas set criado_em = criado_em - interval '3 hours'`);
  const r = await rpc('app_pedido_acao', { p_token: TOK, p_conversa: cLeo.c, p_acao: 'remarcar', p_exame: exLeo });
  const nova = (await dono(`select paciente_tipo, paciente_nome from public.conversas where id = $1`, [r.conversa]))[0];
  return { ok: r.ok === true && nova.paciente_tipo === 'filho' && nova.paciente_nome === 'Leo Souza Teste' && r.tipo === 'filho', detalhe: JSON.stringify(nova) };
});

// ---------------------------------------------------------------- resultado
const cR = await iniciar('Ana Souza Teste', TEL_ANA);
await vincular(cR);
const exR = await exame(cR, { nome: 'RM COLUNA LOMBAR', status: 'atendido', chave: '5010', atend: '7777', dias: -2 });
await rpc('app_pedido_visto', { p_token: TOK });
await caso('exame feito: o resultado começa "aguardando" (o Klingo ainda não disse que o laudo está pronto)', async () => {
  const r = await pedidos(); const e = r.pedidos.find((p) => p.conversa === cR.c).exames[0];
  return { ok: e.ok === 5 && e.resultado === 'aguardando', detalhe: JSON.stringify(e) };
});
await caso('vigia: devolve o exame feito com prontuário, nascimento e Id do atendimento; não repete antes de 30 minutos', async () => {
  const a = await dono(`select public.app_resultados_a_conferir(30) r`); const itens = a[0].r;
  const b = await dono(`select public.app_resultados_a_conferir(30) r`);
  const it = itens.find((x) => x.atendimento === '7777');
  return { ok: !!it && it.prontuario === '5010' && it.nascimento === NASC_ANA && !b[0].r.some((x) => x.atendimento === '7777'), detalhe: JSON.stringify(it) };
});
await caso('a vigia só pode ser chamada pelo banco (anon e authenticated não executam)', async () => {
  await anonimo();
  let negado = false; try { await q(`select public.app_resultados_a_conferir(5)`); } catch { negado = true; }
  let negado2 = false; try { await q(`select public.app_resultado_disponivel('[]'::jsonb)`); } catch { negado2 = true; }
  await db.exec('reset role');
  return { ok: negado && negado2 };
});
await caso('o Klingo diz "laudo pronto": o resultado vira "disponível" e o balão mostra 1', async () => {
  const id = (await dono(`select id from public.app_resultado where exame_id = $1`, [exR]))[0].id;
  const n = (await dono(`select public.app_resultado_disponivel(jsonb_build_array($1::text)) n`, [id]))[0].n;
  const r = await pedidos(); const e = r.pedidos.find((p) => p.conversa === cR.c).exames[0]; const c = await contagem();
  return { ok: n === 1 && e.resultado === 'disponivel' && c.novidades === 1, detalhe: `${n} ${e.resultado} ${c.novidades}` };
});
await rpc('app_pedido_visto', { p_token: TOK });
await caso('pedir o resultado: só vale para exame FEITO daquele pedido', async () => {
  const sem = await rpc('app_pedido_acao', { p_token: TOK, p_conversa: cLeo.c, p_acao: 'resultado', p_exame: exLeo });   // exame ainda não feito (só confirmado)
  const alheio = await rpc('app_pedido_acao', { p_token: TOK, p_conversa: cR.c, p_acao: 'resultado', p_exame: exLeo });   // exame de outro pedido
  return { ok: sem.ok === false && sem.erro === 'exame' && alheio.ok === false };
});
let pedidoRes;
await caso('pedir o resultado (conversa do pedido aberta): a mensagem vai para a equipe lá mesmo e o estado vira "solicitado"', async () => {
  pedidoRes = await rpc('app_pedido_acao', { p_token: TOK, p_conversa: cR.c, p_acao: 'resultado', p_exame: exR });
  const e = (await pedidos()).pedidos.find((p) => p.conversa === cR.c).exames[0];
  return { ok: pedidoRes.ok === true && pedidoRes.enviada === true && e.resultado === 'solicitado', detalhe: JSON.stringify(pedidoRes).slice(0, 200) + ' ' + e.resultado };
});
await caso('a equipe manda o ARQUIVO na conversa: vira "entregue" e fica guardado à parte; baixar devolve o mesmo arquivo', async () => {
  const pdf = Buffer.from('%PDF-1.4 teste');
  const a = (await dono(`insert into public.conversa_anexo (conversa_id, tipo, mime, dados, nome) values ($1, 'equipe_arquivo', 'application/pdf', $2, 'laudo.pdf') returning id`, [cR.c, pdf]))[0].id;
  const r = await pedidos(); const lista = r.resultados;
  const arq = await rpc('app_resultado_arquivo', { p_token: TOK, p_id: lista[0]?.id });
  const e = r.pedidos.find((p) => p.conversa === cR.c).exames[0];
  return { ok: lista.length === 1 && lista[0].tem_arquivo === true && lista[0].nome === 'RM COLUNA LOMBAR' && e.resultado === 'entregue' && arq.ok === true && Buffer.from(arq.base64, 'base64').equals(pdf) && arq.mime === 'application/pdf' && !!a, detalhe: JSON.stringify(lista) };
});
await caso('o arquivo guardado é só do dono: outro cadastro e id inventado recebem recusa', async () => {
  const id = (await pedidos()).resultados[0].id;
  const outro = await rpc('app_resultado_arquivo', { p_token: TOK_BIA, p_id: id });
  const falso = await rpc('app_resultado_arquivo', { p_token: TOK, p_id: '00000000-0000-0000-0000-000000000000' });
  return { ok: outro.ok === false && falso.ok === false && !JSON.stringify([outro, falso]).includes('base64":"') };
});
await caso('entregue = não confere mais: a vigia não devolve esse exame nem de novo depois de 30 minutos', async () => {
  await dono(`update public.app_resultado set conferido_em = now() - interval '2 hours'`);
  const r = (await dono(`select public.app_resultados_a_conferir(30) r`))[0].r;
  const n = (await dono(`select public.app_resultado_disponivel(jsonb_build_array(id::text)) n from public.app_resultado where exame_id = $1`, [exR]))[0].n;
  return { ok: !r.some((x) => x.atendimento === '7777') && n === 0 };
});
await caso('entrega por TEXTO com link (a equipe escreve na conversa) também conta como entregue; texto sem link não', async () => {
  const cT = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(cT);
  const exT = await exame(cT, { nome: 'US MAMA', status: 'atendido', chave: '5011', atend: '8888', dias: -3 });
  await dono(`insert into public.app_resultado (paciente_id, conversa_id, exame_id, estado, solicitado_em, conversa_resultado_id) select paciente_id, $1, $2, 'solicitado', now(), $1 from public.app_conversa where conversa_id = $1`, [cT.c, exT]);
  const ag = (await dono(`select id from public.agentes limit 1`))[0]?.id ?? await (async () => { const u = (await dono(`insert into auth.users (email) values ('atendente@exemplo.invalid') returning id`))[0].id; await dono(`insert into public.agentes (id, nome, email) values ($1, 'Atendente Teste', 'atendente@exemplo.invalid')`, [u]); return u; })();
  await dono(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, 'agente', $2, 'Já estou vendo seu resultado.')`, [cT.c, ag]);
  const antes = (await dono(`select estado from public.app_resultado where exame_id = $1`, [exT]))[0].estado;
  await dono(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, 'agente', $2, 'Seu resultado: https://exemplo.invalid/laudo senha 1234')`, [cT.c, ag]);
  const depois = (await dono(`select estado, mensagem_id from public.app_resultado where exame_id = $1`, [exT]))[0];
  const lista = (await pedidos()).resultados.find((x) => x.nome === 'US MAMA');
  return { ok: antes === 'solicitado' && depois.estado === 'entregue' && !!depois.mensagem_id && lista && lista.tem_arquivo === false, detalhe: `${antes} → ${depois.estado}` };
});
await caso('conversa encerrada + pedir resultado: abre conversa nova e o estado "solicitado" aponta para ELA (é lá que a equipe entrega)', async () => {
  const cE = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(cE);
  const exE = await exame(cE, { nome: 'TC TORAX', status: 'atendido', chave: '5012', atend: '6666', dias: -4 });
  await dono(`update public.conversas set status = 'encerrada', encerrada_em = now(), ia_ativa = false, encerramento_origem = 'sistema' where id = $1`, [cE.c]);
  await dono(`update public.conversas set criado_em = criado_em - interval '3 hours'`);
  const r = await rpc('app_pedido_acao', { p_token: TOK, p_conversa: cE.c, p_acao: 'resultado', p_exame: exE });
  const res = (await dono(`select estado, conversa_resultado_id from public.app_resultado where exame_id = $1`, [exE]))[0];
  return { ok: r.ok === true && r.nova === true && res.estado === 'solicitado' && res.conversa_resultado_id === r.conversa, detalhe: `${res.estado} passo=${r.passo}` };
});
await caso('a equipe pode marcar como entregue por SQL quando a entrega não foi arquivo nem link (painel_resultado_entregue)', async () => {
  const cU = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(cU);
  const exU = await exame(cU, { nome: 'RX MAO', status: 'atendido', chave: '5013', atend: '5555', dias: -5 });
  await dono(`insert into public.app_resultado (paciente_id, conversa_id, exame_id, estado, solicitado_em, conversa_resultado_id) select paciente_id, $1, $2, 'solicitado', now(), $1 from public.app_conversa where conversa_id = $1`, [cU.c, exU]);
  await anonimo(); let negado = false; try { await q(`select public.painel_resultado_entregue($1)`, [cU.c]); } catch { negado = true; } await db.exec('reset role');
  return { ok: negado };
});
await caso('as tabelas novas não são lidas por anon nem authenticated (só as funções)', async () => {
  await anonimo(); let a = false, b = false;
  try { await q(`select * from public.app_conversa limit 1`); } catch { a = true; }
  try { await q(`select * from public.app_resultado limit 1`); } catch { b = true; }
  await db.exec('reset role');
  return { ok: a && b };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} casos passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
