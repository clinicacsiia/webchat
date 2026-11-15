// FLUXOGRAMA: entrada (o retrato da produção + acesso rápido + acompanhar-pedidos.sql + acompanhar-encerrados.sql; conversas abertas pelo motor REAL do chat; encerradas, reabertas e canceladas como o painel faz; cartões/exames da Jornada inventados)
//   -> validação (cada chamada como "anon" com o código do aparelho; conversa de outra pessoa, aparelho travado, prazo e exame marcado são recusados)
//   -> lógica (a lista mostra o estado da conversa no painel com o motivo; avaliar, reabrir, apagar e cancelar-e-apagar; apagar sozinho em 30 dias; ordem pelo dia mais perto e pela atualização)
//   -> saída (PASS/FAIL por caso; sai com erro se algum falhar)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (pedidos encerrados, avaliar, reabrir, apagar)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, anonimo } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-paciente.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acesso-rapido-chat.sql`, 'utf8'));
await db.exec(readFileSync(`${REPO}/supabase/acompanhar-pedidos.sql`, 'utf8'));   // a versão anterior: o teste prova também a passagem para a nova
const sqlNovo = readFileSync(`${REPO}/supabase/acompanhar-encerrados.sql`, 'utf8');
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));
await db.exec(`update public.config set valor = 'sim' where chave = 'app_acesso_modo'`);
await db.exec(`update public.config set valor = 'sim' where chave = 'avaliacao_ativa'`);

const rpc = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  await anonimo();
  try { return (await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k]))))[0].r; }
  finally { await db.exec('reset role'); }
};
const dono = (s, p) => q(s, p);
const NASC_ANA = '1988-04-12';
const TEL_ANA = '71991230001', TEL_BIA = '71991230002';
const cad = (tel, nome, nasc) => rpc('app_cadastrar', { p_telefone: tel, p_nome: nome, p_nascimento: nasc, p_pin: '1357', p_filhos: [], p_aparelho: 'teste' });
const ana = await cad(TEL_ANA, 'Ana Souza Teste', NASC_ANA);
const bia = await cad(TEL_BIA, 'Bia Amiga Teste', '1990-01-01');
const TOK = ana.token, TOK_BIA = bia.token;
const iniciar = async (nome, tel, email = 'ana@exemplo.invalid') => {
  await dono(`update public.conversas set criado_em = criado_em - interval '2 hours'`);
  const r = await rpc('chat_iniciar', { p_nome: nome, p_telefone: tel, p_email: email, p_aceite: true });
  return { c: r.conversa_id, t: r.token };
};
const vincular = (c, tok = TOK) => rpc('app_conversa_vincular', { p_token: tok, p_conversa: c.c, p_conv_token: c.t });
const pedidos = (tok = TOK, renova = true) => rpc('app_pedidos', { p_token: tok, p_renova: renova });
const achar = async (c, tok = TOK) => (await pedidos(tok)).pedidos.find((p) => p.conversa === c.c);
await dono(`insert into public.jornada_coluna (id, nome, ordem, etapa, origem) values ('agendado', 'Agendado', 1, 'agendamento', 'klingo'), ('chegou', 'Chegou', 2, 'depois', 'klingo'), ('em_atendimento', 'Em atendimento', 3, 'depois', 'klingo') on conflict do nothing`);
let seq = 100;
const exame = async (c, { nome = 'RM JOELHO DIREITO', status = 'agendado', conf = null, coluna = 'agendado', dias = 3, chave = String(5000 + (++seq)) } = {}) => {
  const card = (await dono(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna, conversa_id) values ($1, current_date, 'Centro', $2, $3) returning id`, [chave, coluna, c.c]))[0].id;
  return (await dono(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, status, confirm_status, unidade, atendimento_id, agendado_para) values ($1, $2, $3, $4, $5, 'Centro', $6, now() + make_interval(days => $7)) returning id`,
    [card, 'm' + (++seq), nome, status, conf, String(++seq), dias]))[0].id;
};
// O que o painel faz ao encerrar (com a despedida e o registro do encerramento pelos gatilhos reais)
const encerrar = (c, motivo = 'agendado', origem = 'equipe') => dono(`update public.conversas set status = 'encerrada', ia_ativa = false, motivo_encerramento = $2, encerramento_origem = $3 where id = $1`, [c.c, motivo, origem]);
const conversa = async (c) => (await dono(`select status, ia_ativa, motivo_encerramento m, encerramento_origem o, encerrada_em, agente_id, cliente_aguarda_desde from public.conversas where id = $1`, [c.c]))[0];
const ATE = '00000000-0000-4000-8000-0000000000a1';
await db.exec(`insert into auth.users (id, email) values ('${ATE}', 'ate@exemplo.invalid') on conflict (id) do nothing; insert into public.agentes (id, nome, email, papel, ativo) values ('${ATE}', 'Ate Teste', 'ate@exemplo.invalid', 'atendente', true) on conflict (id) do nothing`);
// A equipe assume a conversa (o gatilho real marca o primeiro atendimento humano). Abrir uma conversa nova fecha as anteriores sem humano; com humano elas ficam abertas, como na clínica.
const assumir = (c) => dono(`update public.conversas set agente_id = $2, status = 'em_atendimento', encerrada_em = null, motivo_encerramento = null, encerramento_origem = null where id = $1`, [c.c, ATE]);
const dias = (n) => `now() - interval '${n} days'`;

// ---------------------------------------------------------------- passagem da versão antiga para a nova (nada vira "novidade" só porque a assinatura mudou)
const cAna = await iniciar('Ana Souza Teste', TEL_ANA);
await vincular(cAna);
const exAna = await exame(cAna, { nome: 'RM JOELHO DIREITO', status: 'agendado', dias: 5 });
await rpc('app_pedido_visto', { p_token: TOK });
await encerrar(cAna, 'agendado');
await rpc('app_pedido_visto', { p_token: TOK });          // visto como a versão ANTIGA calculava
await caso('acompanhar-encerrados.sql aplica duas vezes sem erro (idempotente) e o que já existia NÃO vira novidade', async () => {
  await db.exec(sqlNovo); await db.exec(sqlNovo);
  const r = await pedidos();
  return { ok: r.ok === true && r.novidades === 0 && r.pedidos.length === 1, detalhe: `novidades=${r.novidades} pedidos=${r.pedidos.length}` };
});

// ---------------------------------------------------------------- o que o painel encerrou aparece, com o motivo
await caso('conversa encerrada no painel: aparece como encerrada, com o motivo, a data e quando some sozinha', async () => {
  const p = await achar(cAna);
  const apaga = new Date(p.apaga_em).getTime() - Date.now();
  return { ok: p.aberta === false && p.status === 'encerrada' && p.motivo === 'agendado' && p.origem === 'equipe' && !!p.encerrada_em && apaga > 34 * 86400000 && apaga < 36 * 86400000 && p.exames.length === 1,
    detalhe: `${p.status} ${p.motivo} apaga_em ${p.apaga_em}` };
});
await caso('a equipe encerrar vira novidade (balão) e some depois de visto', async () => {
  const cB = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(cB);
  await exame(cB, { nome: 'US ABDOME TOTAL', status: 'confirmado', conf: 'confirmado', dias: 2 });
  await rpc('app_pedido_visto', { p_token: TOK });
  const antes = (await rpc('app_pedidos_contagem', { p_token: TOK })).novidades;
  await encerrar(cB, 'apenas_informacoes');
  const depois = (await rpc('app_pedidos_contagem', { p_token: TOK })).novidades;
  await rpc('app_pedido_visto', { p_token: TOK, p_conversa: cB.c });
  const fim = (await rpc('app_pedidos_contagem', { p_token: TOK })).novidades;
  return { ok: antes === 0 && depois === 1 && fim === 0, detalhe: `${antes} → ${depois} → ${fim}` };
});
await caso('pode avaliar (a despedida foi publicada) e pode reabrir; conversa aberta não mostra avaliar nem reabrir', async () => {
  const p = await achar(cAna);
  const cA = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(cA); await exame(cA, { nome: 'TC CRANIO', dias: 9 });
  const aberta = await achar(cA);
  return { ok: p.pode_avaliar === true && p.pode_reabrir === true && p.avaliou === false && aberta.aberta === true && aberta.pode_avaliar === false && aberta.pode_reabrir === false, detalhe: JSON.stringify([p.pode_avaliar, p.pode_reabrir, aberta.pode_avaliar, aberta.pode_reabrir]) };
});

// ---------------------------------------------------------------- conversas SEM exame
await caso('sem exame: encerrada pela equipe (apenas informações) aparece; "não respondido", "nova conversa" e aberta sem humano não aparecem; aberta com humano aparece', async () => {
  const mk = async () => { const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c); return c; };
  const info = await mk(); await encerrar(info, 'apenas_informacoes');
  const nr = await mk(); await encerrar(nr, 'nao_respondido', 'inatividade');
  const nova = await mk(); await encerrar(nova, 'nova_conversa', 'paciente');
  const solta = await mk();
  const humano = await mk(); await assumir(humano);
  const lista = (await pedidos()).pedidos.map((p) => p.conversa);
  const r = { info: lista.includes(info.c), nr: lista.includes(nr.c), nova: lista.includes(nova.c), solta: lista.includes(solta.c), humano: lista.includes(humano.c) };
  return { ok: r.info && !r.nr && !r.nova && !r.solta && r.humano, detalhe: JSON.stringify(r) };
});
await caso('"não respondido" não convida a avaliar; substituída por conversa nova não reabre', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c); await exame(c, { nome: 'RX TORAX', dias: 4 });
  await encerrar(c, 'nao_respondido', 'inatividade');
  const nr = await achar(c);
  const d = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(d); await exame(d, { nome: 'RX PUNHO', dias: 4 });
  await encerrar(d, 'nova_conversa', 'paciente');
  const sub = await achar(d);
  return { ok: nr.pode_avaliar === false && nr.pode_reabrir === true && sub.pode_reabrir === false && sub.origem === 'paciente', detalhe: JSON.stringify([nr.pode_avaliar, nr.pode_reabrir, sub.pode_reabrir]) };
});

// ---------------------------------------------------------------- avaliar
await caso('avaliar: grava a avaliação do chat (a mesma tabela), uma vez só por encerramento; depois não convida mais', async () => {
  const r1 = await rpc('app_pedido_avaliar', { p_token: TOK, p_conversa: cAna.c, p_nota_atendimento: 9, p_nota_site: 10, p_canal: 'Google' });
  const r2 = await rpc('app_pedido_avaliar', { p_token: TOK, p_conversa: cAna.c, p_nota_atendimento: 1, p_nota_site: 1, p_canal: 'Google' });
  const n = (await dono(`select count(*)::int n, min(nota_atendimento) a from public.avaliacao_atendimento where conversa_id = $1`, [cAna.c]))[0];
  const p = await achar(cAna);
  return { ok: r1.ok === true && r1.nova === true && r2.nova === false && n.n === 1 && n.a === 9 && p.pode_avaliar === false && p.avaliou === true, detalhe: JSON.stringify([r1, r2, n]) };
});
await caso('avaliar: nota inválida, canal inválido, conversa aberta e conversa de outra pessoa são recusados com mensagem simples', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c); await exame(c, { nome: 'US MAMA', dias: 6 });
  const aberta = await rpc('app_pedido_avaliar', { p_token: TOK, p_conversa: c.c, p_nota_atendimento: 5, p_nota_site: 5, p_canal: 'Google' });
  await encerrar(c, 'agendado');
  const nota = await rpc('app_pedido_avaliar', { p_token: TOK, p_conversa: c.c, p_nota_atendimento: 11, p_nota_site: 5, p_canal: 'Google' });
  const canal = await rpc('app_pedido_avaliar', { p_token: TOK, p_conversa: c.c, p_nota_atendimento: 5, p_nota_site: 5, p_canal: 'Rádio' });
  const alheia = await rpc('app_pedido_avaliar', { p_token: TOK_BIA, p_conversa: c.c, p_nota_atendimento: 5, p_nota_site: 5, p_canal: 'Google' });
  return { ok: aberta.ok === false && /encerramento/i.test(aberta.mensagem) && nota.ok === false && /nota/i.test(nota.mensagem) && canal.ok === false && /conheceu/i.test(canal.mensagem) && alheia.ok === false && alheia.erro === 'conversa',
    detalhe: JSON.stringify([aberta.mensagem, nota.mensagem, canal.mensagem, alheia.erro]) };
});

// ---------------------------------------------------------------- reabrir
await caso('reabrir: a conversa volta para a FILA DA EQUIPE (não para o assistente), com a mensagem do paciente, e não vira novidade', async () => {
  const antes = await conversa(cAna);
  const r = await rpc('app_pedido_reabrir', { p_token: TOK, p_conversa: cAna.c });
  const dep = await conversa(cAna);
  const msg = (await dono(`select texto from public.mensagens where conversa_id = $1 and autor = 'cliente' order by id desc limit 1`, [cAna.c]))[0];
  const p = await achar(cAna);
  return { ok: antes.status === 'encerrada' && r.ok === true && r.reaberta === true && r.token === cAna.t && r.conversa === cAna.c && dep.status === 'aguardando' && dep.ia_ativa === false && dep.encerrada_em === null && dep.m === null
    && !!dep.cliente_aguarda_desde && /reabrir/i.test(msg.texto) && p.aberta === true && p.novo === false && p.pode_reabrir === false, detalhe: JSON.stringify([dep, msg, r.erro]) };
});
await caso('reabrir de novo (já aberta) não faz nada de errado; conversa de outra pessoa, substituída por outra e passada de 30 dias são recusadas', async () => {
  const igual = await rpc('app_pedido_reabrir', { p_token: TOK, p_conversa: cAna.c });
  const alheia = await rpc('app_pedido_reabrir', { p_token: TOK_BIA, p_conversa: cAna.c });
  const c1 = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c1); await exame(c1, { nome: 'RX JOELHO', dias: 4 }); await encerrar(c1, 'nova_conversa', 'paciente');
  const sub = await rpc('app_pedido_reabrir', { p_token: TOK, p_conversa: c1.c });
  const c2 = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c2); await exame(c2, { nome: 'RX OMBRO', dias: 4 }); await encerrar(c2, 'agendado');
  await dono(`update public.conversas set encerrada_em = ${dias(31)} where id = $1`, [c2.c]);
  const velha = await rpc('app_pedido_reabrir', { p_token: TOK, p_conversa: c2.c });
  const st = await conversa(c2);
  return { ok: igual.ok === true && alheia.erro === 'conversa' && sub.erro === 'substituida' && velha.erro === 'prazo' && st.status === 'encerrada', detalhe: JSON.stringify([igual.ok, alheia.erro, sub.erro, velha.erro]) };
});
await caso('reabrir dentro dos 30 dias vale mesmo passados os 2 dias do chat comum', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c); await exame(c, { nome: 'RX COLUNA', dias: 4 }); await encerrar(c, 'agendado');
  await dono(`update public.conversas set encerrada_em = ${dias(12)} where id = $1`, [c.c]);
  const r = await rpc('app_pedido_reabrir', { p_token: TOK, p_conversa: c.c });
  const st = await conversa(c);
  return { ok: r.ok === true && st.status === 'aguardando', detalhe: JSON.stringify([r.ok, st.status]) };
});

// ---------------------------------------------------------------- apagar
await caso('apagar conversa encerrada: some da lista do paciente, a conversa e as mensagens continuam no painel', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c); await exame(c, { nome: 'TC TORAX', dias: 8 }); await encerrar(c, 'desistiu');
  const antes = await achar(c);
  const r = await rpc('app_pedido_apagar', { p_token: TOK, p_conversa: c.c });
  const dep = await achar(c);
  const noBanco = (await dono(`select (select count(*)::int from public.conversas where id = $1) c, (select count(*)::int from public.mensagens where conversa_id = $1) m, (select removido_por from public.app_conversa where conversa_id = $1) por`, [c.c]))[0];
  const de = await rpc('app_pedido_apagar', { p_token: TOK, p_conversa: c.c });   // de novo: sem erro
  return { ok: !!antes && r.ok === true && r.cancelado === false && dep === undefined && noBanco.c === 1 && noBanco.m > 0 && noBanco.por === 'paciente' && de.ok === true, detalhe: JSON.stringify([r, noBanco]) };
});
await caso('apagar a conversa de outra pessoa é recusado e nada some', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c); await exame(c, { nome: 'TC ABDOME', dias: 8 }); await encerrar(c, 'agendado');
  const r = await rpc('app_pedido_apagar', { p_token: TOK_BIA, p_conversa: c.c });
  const ainda = await achar(c);
  return { ok: r.ok === false && r.erro === 'conversa' && !!ainda, detalhe: JSON.stringify(r) };
});
await caso('apagada e REABERTA (chat ou equipe) volta a aparecer', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c); await exame(c, { nome: 'US TIREOIDE', dias: 8 }); await encerrar(c, 'agendado');
  await rpc('app_pedido_apagar', { p_token: TOK, p_conversa: c.c });
  const some = await achar(c);
  await dono(`update public.conversas set status = 'aguardando' where id = $1`, [c.c]);
  const volta = await achar(c);
  return { ok: some === undefined && !!volta && volta.aberta === true };
});
await caso('apagar encerrada com exame ainda marcado só tira da lista (o horário continua) e o aviso para a tela vem em "reservado"', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c); await exame(c, { nome: 'RM OMBRO', dias: 6 }); await encerrar(c, 'agendado');
  const p = await achar(c);
  const exa = (await dono(`select e.status from public.jornada_exame e join public.jornada_card jc on jc.id = e.card_id where jc.conversa_id = $1`, [c.c]))[0].status;
  await rpc('app_pedido_apagar', { p_token: TOK, p_conversa: c.c });
  const exa2 = (await dono(`select e.status from public.jornada_exame e join public.jornada_card jc on jc.id = e.card_id where jc.conversa_id = $1`, [c.c]))[0].status;
  return { ok: p.reservado === true && p.pode_apagar === true && exa === 'agendado' && exa2 === 'agendado', detalhe: JSON.stringify([p.reservado, exa, exa2]) };
});

// ---------------------------------------------------------------- cancelar e apagar (pedido ainda sem exame marcado)
const comPedido = async (nome, status = 'pronto') => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c);
  await dono(`insert into public.pre_agendamentos (conversa_id, tipo, status, procedimento) values ($1, 'exame', $2, $3)`, [c.c, status, nome]);
  await dono(`insert into public.pre_agendamento_itens (conversa_id, procedimento) values ($1, $2)`, [c.c, nome]);
  return c;
};
await caso('pedido aberto SEM exame marcado: apagar = cancelar o pedido, avisar a equipe na conversa, encerrar como "Paciente desistiu" e tirar da lista', async () => {
  const c = await comPedido('RM COLUNA LOMBAR');
  const antes = await achar(c);
  const r = await rpc('app_pedido_apagar', { p_token: TOK, p_conversa: c.c });
  const pre = (await dono(`select status from public.pre_agendamentos where conversa_id = $1`, [c.c]))[0].status;
  const itens = (await dono(`select count(*)::int n from public.pre_agendamento_itens where conversa_id = $1 and ativo`, [c.c]))[0].n;
  const st = await conversa(c);
  const aviso = (await dono(`select texto from public.mensagens where conversa_id = $1 and autor = 'sistema' and texto like '%cancelou este pedido%'`, [c.c]))[0];
  const enc = (await dono(`select motivo, origem from public.conversa_encerramento where conversa_id = $1`, [c.c]))[0];
  const dep = await achar(c);
  return { ok: antes.aberta === true && antes.pode_apagar === true && antes.cancela_ao_apagar === true && r.ok === true && r.cancelado === true && pre === 'cancelado' && itens === 0
    && st.status === 'encerrada' && st.m === 'desistiu' && st.o === 'sistema' && !!aviso && enc.motivo === 'desistiu' && dep === undefined, detalhe: JSON.stringify([r, pre, itens, st.status, st.m, !!aviso]) };
});
await caso('pedido aberto COM exame marcado: apagar é recusado (primeiro cancela o exame pela conversa) e nada muda', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c); await exame(c, { nome: 'RM PELVE', dias: 7 });
  const p = await achar(c);
  const r = await rpc('app_pedido_apagar', { p_token: TOK, p_conversa: c.c });
  const st = await conversa(c);
  const ainda = await achar(c);
  return { ok: p.pode_apagar === false && r.ok === false && r.erro === 'ativo' && /cancele o exame/i.test(r.mensagem) && st.status !== 'encerrada' && !!ainda, detalhe: JSON.stringify([p.pode_apagar, r.erro, st.status]) };
});
await caso('pedido cancelado no painel (pré-agendamento cancelado) aparece como cancelado e pode ser apagado', async () => {
  const c = await comPedido('US PELVICO');
  await exame(c, { nome: 'US PELVICO', status: 'pedido', coluna: 'agendado', dias: 0 });
  await dono(`update public.pre_agendamentos set status = 'cancelado' where conversa_id = $1`, [c.c]);
  const p = await achar(c);
  return { ok: p.exames.every((e) => e.excecao === 'cancelado') && p.pode_apagar === true, detalhe: JSON.stringify(p.exames.map((e) => [e.nome, e.excecao, e.ok])) };
});

// ---------------------------------------------------------------- apagar sozinho em 30 dias
await caso('30 dias depois do encerramento some sozinha; com 29 dias continua', async () => {
  const a = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(a); await exame(a, { nome: 'RX BACIA', status: 'atendido', dias: -40 }); await encerrar(a, 'agendado');
  const b = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(b); await exame(b, { nome: 'RX FEMUR', status: 'atendido', dias: -40 }); await encerrar(b, 'agendado');
  await dono(`update public.conversas set encerrada_em = ${dias(31)} where id = $1`, [a.c]);
  await dono(`update public.conversas set encerrada_em = ${dias(29)} where id = $1`, [b.c]);
  return { ok: (await achar(a)) === undefined && !!(await achar(b)) };
});
await caso('encerrada há mais de 30 dias mas com exame marcado por vir: NÃO some antes do exame (conta 30 dias depois da data do exame)', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c); await exame(c, { nome: 'RM CERVICAL', status: 'agendado', dias: 20 }); await encerrar(c, 'agendado');
  await dono(`update public.conversas set encerrada_em = ${dias(45)} where id = $1`, [c.c]);
  const p = await achar(c);
  const dentro = new Date(p.apaga_em).getTime() - Date.now();
  return { ok: !!p && dentro > 48 * 86400000 && dentro < 52 * 86400000, detalhe: `apaga em ${(dentro / 86400000).toFixed(1)} dias` };
});

// ---------------------------------------------------------------- ordem
await caso('ordem: abertas primeiro; o dia mais perto antes; sem dia, a atualizada por último primeiro; encerradas no fim (a mais recente primeiro)', async () => {
  await dono(`update public.app_conversa set removido_em = now(), removido_por = 'paciente' where paciente_id = (select paciente_id from public.app_conversa limit 1)`);   // limpa a mesa
  const longe = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(longe); await exame(longe, { nome: 'EX LONGE', dias: 20 }); await assumir(longe);
  const perto = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(perto); await exame(perto, { nome: 'EX PERTO', dias: 1 }); await assumir(perto);
  const meio = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(meio); await exame(meio, { nome: 'EX MEIO', dias: 6 }); await assumir(meio);
  const semA = await comPedido('PEDIDO SEM DIA A'); await assumir(semA);
  const semB = await comPedido('PEDIDO SEM DIA B'); await assumir(semB);
  await dono(`update public.conversas set atualizado_em = now() - interval '3 hours' where id = $1`, [semA.c]);
  await dono(`update public.conversas set atualizado_em = now() - interval '1 hour' where id = $1`, [semB.c]);
  const enc1 = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(enc1); await exame(enc1, { nome: 'EX ENC ANTIGO', dias: -5 }); await encerrar(enc1, 'agendado');
  const enc2 = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(enc2); await exame(enc2, { nome: 'EX ENC RECENTE', dias: -5 }); await encerrar(enc2, 'agendado');
  await dono(`update public.conversas set encerrada_em = ${dias(10)} where id = $1`, [enc1.c]);
  await dono(`update public.conversas set encerrada_em = ${dias(2)} where id = $1`, [enc2.c]);
  const esperado = ['EX PERTO', 'EX MEIO', 'EX LONGE', 'PEDIDO SEM DIA B', 'PEDIDO SEM DIA A', 'EX ENC RECENTE', 'EX ENC ANTIGO'];
  const meus = (await pedidos()).pedidos.filter((p) => p.exames.length && esperado.includes(p.exames[0].nome));   // outras conversas abertas dos casos acima ficam de fora da conta
  const nomes = meus.map((p) => p.exames[0].nome);
  return { ok: JSON.stringify(nomes) === JSON.stringify(esperado), detalhe: nomes.join(' > ') };
});
await caso('dentro do cartão: o que ainda vai acontecer vem primeiro (do mais perto), depois o que já passou (o mais recente primeiro)', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c);
  const card = (await dono(`insert into public.jornada_card (paciente_chave, data_ref, unidade, coluna, conversa_id) values ('7001', current_date, 'Centro', 'agendado', $1) returning id`, [c.c]))[0].id;
  for (const [nome, d, st] of [['PASSADO LONGE', -9, 'atendido'], ['FUTURO LONGE', 12, 'agendado'], ['PASSADO PERTO', -2, 'atendido'], ['FUTURO PERTO', 3, 'agendado']]) {
    await dono(`insert into public.jornada_exame (card_id, marcacao_id, procedimento, status, unidade, atendimento_id, agendado_para) values ($1, $2, $3, $4, 'Centro', $5, now() + make_interval(days => $6))`, [card, 'o' + (++seq), nome, st, String(++seq), d]);
  }
  const p = await achar(c);
  return { ok: p.exames.map((e) => e.nome).join('|') === 'FUTURO PERTO|FUTURO LONGE|PASSADO PERTO|PASSADO LONGE', detalhe: p.exames.map((e) => e.nome).join('|') };
});

// ---------------------------------------------------------------- segurança
await caso('travado (PIN vencido): apagar, reabrir e avaliar pedem o PIN e não mexem em nada', async () => {
  const c = await iniciar('Ana Souza Teste', TEL_ANA); await vincular(c); await exame(c, { nome: 'RX MAO', dias: 3 }); await encerrar(c, 'agendado');
  await dono(`update public.app_aparelho set desbloqueada_ate = now() - interval '1 minute'`);
  const a = await rpc('app_pedido_apagar', { p_token: TOK, p_conversa: c.c });
  const b = await rpc('app_pedido_reabrir', { p_token: TOK, p_conversa: c.c });
  const v = await rpc('app_pedido_avaliar', { p_token: TOK, p_conversa: c.c, p_nota_atendimento: 5, p_nota_site: 5, p_canal: 'Google' });
  await dono(`update public.app_aparelho set desbloqueada_ate = now() + interval '30 minutes'`);
  const st = await conversa(c);
  return { ok: a.erro === 'bloqueado' && b.erro === 'bloqueado' && v.erro === 'bloqueado' && st.status === 'encerrada' && !!(await achar(c)), detalhe: `${a.erro} ${b.erro} ${v.erro}` };
});
await caso('aparelho desconhecido é recusado nas três ações', async () => {
  const falso = 'z'.repeat(64);
  const a = await rpc('app_pedido_apagar', { p_token: falso, p_conversa: cAna.c });
  const b = await rpc('app_pedido_reabrir', { p_token: falso, p_conversa: cAna.c });
  const v = await rpc('app_pedido_avaliar', { p_token: falso, p_conversa: cAna.c, p_nota_atendimento: 5, p_nota_site: 5, p_canal: 'Google' });
  return { ok: a.erro === 'sessao' && b.erro === 'sessao' && v.erro === 'sessao', detalhe: `${a.erro} ${b.erro} ${v.erro}` };
});
await caso('nada pessoal na lista: sem CPF, e-mail, telefone inteiro nem código de conversa; as funções novas não rodam para quem não tem aparelho (public sem execute)', async () => {
  await dono(`update public.app_paciente set cpf = '52998224725', email = 'ana@exemplo.invalid' where telefone = $1`, [TEL_ANA]);
  const txt = JSON.stringify(await pedidos());
  const tokens = (await dono(`select token from public.conversa_segredo`)).map((x) => x.token);
  const grants = (await dono(`select p.proname, has_function_privilege('anon', p.oid, 'execute') anon from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('app_pedido_dados')`))[0];
  return { ok: !txt.includes('52998224725') && !txt.includes('ana@exemplo') && !txt.includes(TEL_ANA) && tokens.every((t) => !txt.includes(t)) && grants.anon === false };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} casos passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
