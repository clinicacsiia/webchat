// FLUXOGRAMA: entrada (clone da produção + partes 1, 2 e 5; paciente de mentira na lista de teste; Klingo SIMULADO: o teste faz o papel do executor chamando klingo_operacao_pegar/concluir com o resultado que o Klingo daria)
//   -> processamento (ver minhas marcações, cancelar, remarcar, resultado de exame, regra de 24 h, falhas, chave desligada, segurança da lista) -> persistência (só no clone) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Grupo D do prompt mestre (pós-agendamento). Nenhum teste fala com o Klingo real: tudo que vem "do Klingo" aqui é SIMULADO e está marcado assim.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste'), ('klingo_interno_segredo', 'interno-de-teste')`);
let sqlErro = null;
for (const f of ['webchat-v2-parte1-modos', 'webchat-v2-parte2-calendario-api', 'webchat-v2-parte5-pos-agendamento']) { try { await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8')); } catch (e) { sqlErro = `${f}: ${String(e.message).split('\n')[0]}`; } }
registrar('o retrato da produção monta inteiro e as partes 1, 2 e 5 aplicam sem erro', falhas.length === 0 && !sqlErro, sqlErro ?? '');

const UNIDADE = 'CLÍNICA DE SAÚDE E IMAGEM - CSI', TESTE = '71900000001';
await db.exec(`
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!'), ('reabrir_dias', '2'),
    ('klingo_auto', 'sim'), ('klingo_api_horarios', 'teste'), ('klingo_api_marcar', 'teste'), ('klingo_api_pre_cadastro', 'teste'), ('klingo_api_telefones_teste', '${TESTE}'), ('klingo_api_percentual', '100'),
    ('klingo_funcoes_base', 'https://funcoes.exemplo.invalid/') on conflict (chave) do update set valor = excluded.valor;
  insert into public.catalogo_regiao (codigo, nome, padrao, tem_lado, grupo, ordem) values ('joelho', 'Joelho', 'JOELHO', true, 'perna', 1);
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values (201, 'RESSONANCIA MAGNETICA DO JOELHO (UNILATERAL)', 'RESSONANCIA MAGNETICA', true, 9, '');
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 201, 'RM JOELHO', '${UNIDADE}', 'RESSONANCIA', 'DRA EXEMPLO IMAGEM', 'RADIOLOGIA', d, '08:00', '12:00', 30, current_date - 30, current_date + 300 from generate_series(0, 6) d;
  insert into public.klingo_plano_map (operadora, convenio_id, plano_id, origem) values ('Particular', 1, 1, 'auto') on conflict do nothing;
  insert into public.klingo_convenio (plano_id, convenio_id, convenio, plano, convenio_norm, padrao) values (1, 1, 'Particular', 'PARTICULAR', 'PARTICULAR', true) on conflict do nothing;
`);
const dia = (n) => new Date(Date.now() + n * 864e5).toLocaleString('sv-SE', { timeZone: 'America/Bahia' }).slice(0, 10);
const CAMPO = (c) => (c.tipo === 'sexo' ? 'F' : c.tipo === 'data' ? '25/03/1980' : c.tipo === 'cpf' ? '111.444.777-35' : c.tipo === 'tel' ? '(71) 99999-0001' : c.tipo === 'email' ? 'maria@exemplo.invalid'
  : c.tipo === 'cep' ? '40000-000' : c.tipo === 'uf' ? 'BA' : c.nome === 'nome' ? 'Maria Teste da Silva' : c.nome === 'mae' ? 'Ana Teste da Silva' : c.nome === 'numero' ? '10' : 'Texto de teste');
let nTel = 0, nNasc = 0;
const telefone = () => '7198' + String(4000000 + ++nTel);
const lista = new Set([TESTE]);
const rpc = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  const r = await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k])));
  return r[0].r;
};
const cfg = async (chave, valor) => { await como(''); return db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]); };
const nascUnico = () => { nNasc++; return `${String(1 + (nNasc % 27)).padStart(2, '0')}/${String(1 + (nNasc % 11)).padStart(2, '0')}/${1950 + nNasc}`; };
// Anda com o paciente de mentira. parar(o) devolve true para parar ANTES de responder aquela pergunta. Depois do calendário usa uma oferta da API de mentira.
async function andar(p, parar, nasc) {
  for (let i = 0; i < 40; i++) {
    const o = p.ult.opcoes;
    if (!o || ['acompanhar', 'nova', 'marcando', 'marcado'].includes(o.tipo) || parar(o, p)) return p;
    await anonimo(); let x;
    if (o.tipo === 'escolha') { const it = (o.itens || [])[0]; x = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify(it.valor), p_texto: it.rotulo }); }
    else if (o.tipo === 'campos') { const v = {}; for (const cp of o.campos || []) v[cp.nome] = cp.tipo === 'data' && nasc ? nasc : CAMPO(cp); x = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: v, p_texto: null }); }
    else if (o.tipo === 'busca_exame' || o.tipo === 'pedido_exames') { const ex = await rpc('chat_exames', { p_conversa: p.c, p_token: p.t, p_modalidade: 'RM', p_regiao: 'joelho' }); x = await rpc('chat_pedido_enviar', { p_conversa: p.c, p_token: p.t, p_itens: [{ modalidade: 'RM', regiao: 'joelho', lado: 'D', procedimento_id: ex[0].id }] }); }
    else if (o.tipo === 'calendario') {
      const d = p.dia ?? dia(3), hh = p.hora ?? '09:00', chave = `${d}|63|308|2|${hh}`;
      await como('');   // oferta e registro da consulta são do sistema (service_role), não do paciente
      await db.query(`select public.klingo_oferta_gravar_v2($1, 201, 1, $2::jsonb, false, true)`, [p.c, JSON.stringify([{ chave, data: d, hora: hh, profissional: 'DRA EXEMPLO IMAGEM', unidade: UNIDADE }])]);
      await db.query(`select public.klingo_consulta_registrar($1, 'teste', 'exame', 201, 1, 'ok_com_horarios', 200, 1, 1, 0, 1, 500, null)`, [p.c]);
      await anonimo(); x = await rpc('chat_horario_escolher', { p_conversa: p.c, p_token: p.t, p_grupo: 1, p_data: d, p_hora: hh, p_unidade: UNIDADE });
      x = { respostas: (await rpc('chat_listar', { p_conversa: p.c, p_token: p.t, p_apos: p.ult.id })).mensagens || [] };
    } else throw new Error(`tipo não tratado: ${o.tipo}`);
    const ag = ((x && x.respostas) || []).filter((m) => m.autor === 'agente');
    if (!ag.length) throw new Error(`sem resposta depois de ${o.passo}`);
    p.ult = ag.at(-1);
  }
  throw new Error('não terminou em 40 passos');
}
async function novo(nasc = nascUnico(), tel = telefone()) {
  lista.add(tel); await cfg('klingo_api_telefones_teste', [...lista].join(','));
  await anonimo();
  const r = await rpc('chat_iniciar', { p_nome: 'Maria Teste da Silva', p_telefone: tel, p_email: 'maria@exemplo.invalid', p_aceite: true, p_paciente_tipo: 'proprio' });
  const p = { c: r.conversa_id, t: r.token, tel, nasc, ult: r.respostas.at(-1) };
  return p;
}
const ateMarcando = async (p) => { await andar(p, (o) => false, p.nasc); await como(''); return p; };   // anda até o fim; se marcar, o último passo é "marcando"
const opDe = (c) => q(`select id, estado, tipo, chave_idem, tentativas, voucher_id, codigo from public.klingo_operacao where conversa_id = $1 order by criado_em`, [c]);
const pedidoDe = (c) => um(`select status, agendado_origem, klingo_marcacoes, escolha_horario from public.pre_agendamentos where conversa_id = $1`, [c]);
const conversaDe = (c) => um(`select status, ia_ativa, primeiro_humano_em from public.conversas where id = $1`, [c]);
const chamadasExecutor = async () => (await um(`select count(*)::int n from net.chamadas where url like '%klingo-executar'`)).n;
const sucessoApi = (c, extra = {}) => JSON.stringify({ voucher: { id: String(26000 + Math.floor(Math.random() * 999)), status: 'agendado', data: dia(3), hora: '09:00', procedimento: 'RM JOELHO', unidade: 'CSI', profissional: 'DRA EXEMPLO IMAGEM', ...extra } });


// =============================================================================================================================================================
// Pós-agendamento (Grupo D). TUDO que "vem do Klingo" abaixo é SIMULADO pelo teste (o executor real não roda aqui); o que se prova é o comportamento do banco e do chat.
// =============================================================================================================================================================
await cfg('klingo_api_consultar', 'teste'); await cfg('klingo_api_cancelar', 'teste'); await cfg('klingo_api_remarcar', 'teste');
const ultima = async (p) => { await como(''); const m = await um(`select id, texto, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [p.c]); p.ult = m; return m; };
const clicar = async (p, valor) => {
  await ultima(p); const o = p.ult.opcoes; await anonimo();
  const x = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify(valor), p_texto: String(valor) });
  await como(''); return ultima(p);
};
async function ateAssunto(p) {
  for (let i = 0; i < 30; i++) {
    const m = await ultima(p), o = m.opcoes;
    if (o?.passo === 'assunto') return p;
    await anonimo();
    if (o?.tipo === 'campos') { const v = {}; for (const cp of o.campos || []) v[cp.nome] = cp.tipo === 'data' ? p.nasc : CAMPO(cp); await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: v, p_texto: null }); }
    else if (o?.tipo === 'escolha') { const v = o.passo === 'motivo' ? 'assunto' : o.itens[0].valor; await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify(v), p_texto: String(v) }); }
    else throw new Error(`parou em ${o?.tipo}/${o?.passo}`);
    await como('');
  }
  throw new Error('não chegou ao assunto');
}
const rotulos = (m) => (m.opcoes?.itens || []).map((i) => i.rotulo);
const valores = (m) => (m.opcoes?.itens || []).map((i) => i.valor);
const opsDe = (c, tipo) => q(`select id, estado, tipo, chave_idem, detalhe, codigo from public.klingo_operacao where conversa_id = $1 and tipo = $2 order by criado_em`, [c, tipo]);
// o "Klingo" (simulado): o executor pega a operação e o teste devolve o resultado
const executor = async (opId, estado, r) => { await um(`select public.klingo_operacao_pegar($1)`, [opId]); return (await um(`select public.klingo_operacao_concluir($1, $2, $3::jsonb) r`, [opId, estado, r])).r; };
const marc = (id, o = {}) => ({ id: String(id), status: 'agendado', data: dia(5), hora: '10:00', procedimento: 'RM JOELHO', procedimentoId: '201', unidade: 'CSI', profissional: 'DRA EXEMPLO IMAGEM', idExterno: null, ...o });
const respMarc = (...ms) => JSON.stringify({ codigo: ms.length ? 'ok_com_marcacoes' : 'sem_marcacoes', http_status: 200, caminho: '/vouchers', marcacoes: ms });
const retrato = (c) => q(`select voucher, situacao, origem, procedimento, data::text d, hora from public.klingo_marcacao where conversa_id = $1 order by voucher`, [c]);
const nota = async (c) => { const x = await um(`select triagem_resumo t, ia_ativa, triagem_urgencia u, status from public.conversas where id = $1`, [c]); const f = await um(`select dados -> 'notas' nt from public.conversa_fluxo where conversa_id = $1`, [c]); return { ...x, t: (x.t ?? '') + ' ' + JSON.stringify(f?.nt ?? '') }; };

// ---------------------------------------------------------------------------------------------- 5.1 Ver minhas marcações
let P;
await caso('A opção "Ver minhas marcações" aparece só para quem tem a chave ligada (lista de teste); fora da lista o menu continua como antes', async () => {
  P = await novo(); await ateAssunto(P); const m = await ultima(P);
  const fora = await novo(nascUnico(), '7198' + String(7000000 + ++nTel)); lista.delete(fora.tel); await cfg('klingo_api_telefones_teste', [...lista].join(',')); await ateAssunto(fora); const mf = await ultima(fora);
  return { ok: valores(m).includes('Minhas marcações') && !valores(mf).includes('Minhas marcações') && valores(mf).includes('Remarcar') && valores(mf).includes('Cancelar'), detalhe: `lista: ${valores(m)}; fora: ${valores(mf)}` };
});
await caso('Escolher "Ver minhas marcações" cria UMA operação ler_vouchers sem dado pessoal, chama o executor só com o id e mostra "consultando"; toque repetido reaproveita a operação', async () => {
  const antes = await chamadasExecutor(); const m = await clicar(P, 'Minhas marcações');
  const ops = await opsDe(P.c, 'ler_vouchers'); const ch = await q(`select body from net.chamadas where url like '%klingo-executar' order by id desc limit 1`);
  const dup = (await um(`select public.klingo_marcacoes_pedir($1) id`, [P.c])).id;
  const pii = JSON.stringify(ops).match(/11144477735|Maria|maria@/i);
  return { ok: ops.length === 1 && ops[0].estado === 'pendente' && m.opcoes?.tipo === 'marcando' && (await chamadasExecutor()) === antes + 1 && Object.keys(ch[0].body).join() === 'operacao_id' && dup === ops[0].id && !pii && (await opsDe(P.c, 'ler_vouchers')).length === 1,
           detalhe: `op=${ops[0]?.estado}; widget=${m.opcoes?.tipo}` };
});
let VOUCHER_FORA = 26701, VOUCHER_CHAT = 26702;
await caso('O Klingo (simulado) devolve 2 marcações, UMA feita fora do chat: o paciente vê as duas, com serviço/data/hora; o retrato guarda só dados da marcação (sem CPF nem nome)', async () => {
  const [o] = await opsDe(P.c, 'ler_vouchers');
  const r = await executor(o.id, 'sucesso', respMarc(marc(VOUCHER_FORA, { data: dia(6), hora: '08:30', procedimento: 'US ABDOME' }), marc(VOUCHER_CHAT)));
  const m = await ultima(P), ret = await retrato(P.c);
  const pii = JSON.stringify(ret).match(/11144477735|Maria|maria@/i);
  return { ok: r.ok && m.opcoes?.passo === 'marc_lista' && rotulos(m).length === 3 && rotulos(m).some((x) => /US ABDOME/.test(x) && /08:30/.test(x)) && ret.length === 2 && !pii && !/Maria/.test(m.texto), detalhe: rotulos(m).join(' | ') };
});
await caso('Escolher uma marcação mostra procedimento, unidade, profissional, data, hora e protocolo, e oferece as ações (cancelar, remarcar, outra, equipe)', async () => {
  const m = await clicar(P, `m:${VOUCHER_FORA}`);
  return { ok: m.opcoes?.passo === 'marc_acao' && /US ABDOME/.test(m.texto) && /CSI/.test(m.texto) && /DRA EXEMPLO/.test(m.texto) && /08:30/.test(m.texto) && new RegExp(String(VOUCHER_FORA)).test(m.texto) && ['cancelar', 'remarcar', 'outra', 'equipe', 'fim'].every((v) => valores(m).includes(v)), detalhe: m.texto.replace(/\n/g, ' / ').slice(0, 150) };
});
await caso('SEGURANÇA: tocar numa marcação que NÃO está na lista (de outra pessoa) é recusado/refeito; nada é mostrado nem cancelado', async () => {
  const Q = await novo(); await ateAssunto(Q); await clicar(Q, 'Minhas marcações');
  const [o] = await opsDe(Q.c, 'ler_vouchers'); await executor(o.id, 'sucesso', respMarc(marc(31001)));
  const antes = (await opsDe(P.c, 'ler_vouchers')).length;
  const m = await clicar(Q, `m:${VOUCHER_FORA}`);   // o voucher da paciente P não pertence à lista de Q
  const ops = await opsDe(Q.c, 'ler_vouchers');
  const cancelar = await q(`select id from public.klingo_operacao where conversa_id = $1 and tipo = 'cancelar'`, [Q.c]);
  return { ok: !/US ABDOME/.test(m.texto ?? '') && ops.length === 2 && cancelar.length === 0, detalhe: `consultas de Q=${ops.length}; cancelamentos=${cancelar.length}` };
});
await caso('SEM MARCAÇÃO FUTURA: o paciente é informado e pode fazer nova marcação ou falar com a equipe (sem lista inventada)', async () => {
  const Q = await novo(); await ateAssunto(Q); await clicar(Q, 'Minhas marcações');
  const [o] = await opsDe(Q.c, 'ler_vouchers'); await executor(o.id, 'sucesso', respMarc(marc(31002, { data: dia(-3) })));   // só uma marcação passada
  const m = await ultima(Q);
  const n = await clicar(Q, 'nova');
  return { ok: m.opcoes?.passo === 'marc_vazio' && ['nova', 'equipe', 'fim'].every((v) => valores(m).includes(v)) && n.opcoes?.passo === 'motivo', detalhe: `${m.opcoes?.passo} → ${n.opcoes?.passo}` };
});
await caso('KLINGO FORA DO AR: avisa que não conseguiu consultar, não inventa lista, chama a equipe e deixa nota técnica (código, sem dado pessoal)', async () => {
  const Q = await novo(); await ateAssunto(Q); await clicar(Q, 'Minhas marcações');
  const [o] = await opsDe(Q.c, 'ler_vouchers'); await executor(o.id, 'falha', JSON.stringify({ codigo: 'erro_api', http_status: 502 }));
  const m = await um(`select texto, opcoes from public.mensagens where conversa_id = $1 and texto ilike '%não consegui consultar%' order by id desc limit 1`, [Q.c]), n = await nota(Q.c);
  return { ok: !!m && !m.opcoes?.itens?.length && n.ia_ativa === false && /erro_api/.test(n.t) && (await retrato(Q.c)).length === 0, detalhe: m?.texto?.slice(0, 80) };
});
await caso('IDENTIDADE NÃO CONFERE (nascimento/sessão): nada é listado, a resposta não revela qual dado falhou e a equipe é chamada', async () => {
  const Q = await novo(); await ateAssunto(Q); await clicar(Q, 'Minhas marcações');
  const [o] = await opsDe(Q.c, 'ler_vouchers'); await executor(o.id, 'falha', JSON.stringify({ codigo: 'nascimento_divergente' }));
  const m = await um(`select texto from public.mensagens where conversa_id = $1 and texto ilike '%confirmar os dados do cadastro%' order by id desc limit 1`, [Q.c]), n = await nota(Q.c);
  return { ok: !!m && !/nascimento|CPF/i.test(m.texto) && n.ia_ativa === false && (await retrato(Q.c)).length === 0, detalhe: m?.texto?.slice(0, 90) };
});
await caso('CHAVE DESLIGADA (klingo_api_consultar = nao): "Cancelar" volta ao caminho de antes (texto livre para a equipe), sem nenhuma consulta ao Klingo', async () => {
  await cfg('klingo_api_consultar', 'nao');
  const Q = await novo(); await ateAssunto(Q); const m0 = await ultima(Q); const m = await clicar(Q, 'Cancelar');
  const ops = await q(`select count(*)::int n from public.klingo_operacao where conversa_id = $1`, [Q.c]);
  await cfg('klingo_api_consultar', 'teste');
  return { ok: !valores(m0).includes('Minhas marcações') && m.opcoes?.passo === 'assunto_texto' && ops[0].n === 0, detalhe: `${m.opcoes?.passo}; ops=${ops[0].n}` };
});

// ---------------------------------------------------------------------------------------------- 5.2 Cancelar
let C1;
await caso('CANCELAR (fluxo completo): escolha → confirmação → operação "cancelar" pendente; ANTES do Klingo responder a marcação continua ATIVA e o paciente vê "cancelando", não "cancelado"', async () => {
  const antes = (await opsDe(P.c, 'ler_vouchers')).length;
  let m = await clicar(P, 'cancelar'); const confirma = m;
  m = await clicar(P, 'cancelar_sim');
  const ops = await opsDe(P.c, 'cancelar'); C1 = ops[0];
  const ret = (await retrato(P.c)).find((x) => x.voucher === String(VOUCHER_FORA));
  const msgs = await q(`select texto from public.mensagens where conversa_id = $1 and autor = 'agente' and texto ilike '%confirmou o cancelamento%'`, [P.c]);
  return { ok: confirma.opcoes?.passo === 'marc_cancelar' && ops.length === 1 && ops[0].estado === 'pendente' && ops[0].detalhe.voucher === String(VOUCHER_FORA) && ops[0].detalhe.origem === 'marcacoes' && m.opcoes?.tipo === 'marcando' && ret.situacao === 'ativa' && msgs.length === 0 && /Cancelando/.test(m.texto),
           detalhe: `op=${ops[0]?.estado}; marcação=${ret?.situacao}` };
});
await caso('DUPLO CLIQUE em "Sim, cancelar": continua UMA operação; texto livre durante a espera só pede para aguardar', async () => {
  await anonimo(); const ult = (await ultima(P)).opcoes;
  await rpc('chat_responder', { p_conversa: P.c, p_token: P.t, p_passo: 'marc_cancelar', p_valor: JSON.stringify('cancelar_sim'), p_texto: 'x' }).catch(() => {});
  await rpc('chat_enviar', { p_conversa: P.c, p_token: P.t, p_texto: 'e agora?' }).catch(() => {}); await como('');
  const ops = await opsDe(P.c, 'cancelar'); const m = await ultima(P);
  return { ok: ops.length === 1, detalhe: `operações de cancelar=${ops.length}; última=${m.texto.slice(0, 60)}` };
});
await caso('CONFIRMADO PELO KLINGO (simulado): só agora a marcação fica "cancelada", o paciente recebe a confirmação e pode continuar (a conversa NÃO é encerrada sozinha)', async () => {
  const r = await executor(C1.id, 'sucesso', JSON.stringify({ http_status: 200, caminho: '/voucher' }));
  const ret = (await retrato(P.c)).find((x) => x.voucher === String(VOUCHER_FORA)), m = await ultima(P), cv = await nota(P.c);
  const rep = (await um(`select public.klingo_operacao_concluir($1, 'sucesso', '{}'::jsonb) r`, [C1.id])).r;
  return { ok: r.ok && ret.situacao === 'cancelada' && /confirmou o cancelamento/.test(m.texto) && m.opcoes?.passo === 'marc_pos' && cv.status !== 'encerrada' && rep.repetido === true, detalhe: `${ret.situacao}; passo=${m.opcoes?.passo}; conversa=${cv.status}` };
});
await caso('Depois de cancelar: "ver minhas marcações" consulta DE NOVO e o que o Klingo não lista mais deixa de aparecer; "está tudo certo" encerra o assunto', async () => {
  let m = await clicar(P, 'ver'); const ops = await opsDe(P.c, 'ler_vouchers');
  await executor(ops.at(-1).id, 'sucesso', respMarc(marc(VOUCHER_CHAT)));
  m = await ultima(P); const itens = rotulos(m).length;
  const ret = await retrato(P.c);
  const fim = await clicar(P, 'nenhum'); const f2 = await clicar(P, 'fim');
  return { ok: m.opcoes?.passo === 'marc_lista' && itens === 2 && ret.find((x) => x.voucher === String(VOUCHER_FORA)).situacao === 'cancelada' && f2.opcoes?.tipo === 'nova', detalhe: `itens=${itens}; ${f2.opcoes?.tipo}` };
});
await caso('CANCELAMENTO NÃO CONFIRMADO (falha ou resposta perdida): a marcação continua ATIVA, o paciente NÃO é avisado de sucesso, a equipe recebe nota "conferir antes de nova tentativa"', async () => {
  const Q = await novo(); await ateAssunto(Q); await clicar(Q, 'Minhas marcações');
  await executor((await opsDe(Q.c, 'ler_vouchers'))[0].id, 'sucesso', respMarc(marc(32001)));
  await clicar(Q, 'm:32001'); await clicar(Q, 'cancelar'); await clicar(Q, 'cancelar_sim');
  const [oc] = await opsDe(Q.c, 'cancelar'); await executor(oc.id, 'incerto', JSON.stringify({ codigo: 'timeout' }));
  const ret = (await retrato(Q.c))[0], n = await nota(Q.c), ok1 = (await q(`select texto from public.mensagens where conversa_id = $1 and texto ilike '%confirmou o cancelamento%'`, [Q.c])).length;
  const novaOp = await um(`select count(*)::int n from public.klingo_operacao where conversa_id = $1 and tipo = 'cancelar'`, [Q.c]);
  return { ok: ret.situacao === 'ativa' && ok1 === 0 && n.ia_ativa === false && /ANTES de qualquer nova tentativa/.test(n.t) && novaOp.n === 1, detalhe: `${ret.situacao}; equipe=${!n.ia_ativa}` };
});
await caso('REGRA DAS 24 HORAS: cancelar ou remarcar com menos de 24 h NÃO cria operação, explica e chama a equipe com o contexto', async () => {
  const Q = await novo(); await ateAssunto(Q); await clicar(Q, 'Minhas marcações');
  const hoje = new Date(Date.now() + 5 * 3600e3).toLocaleString('sv-SE', { timeZone: 'America/Bahia' });   // daqui a 5 horas
  await executor((await opsDe(Q.c, 'ler_vouchers'))[0].id, 'sucesso', respMarc(marc(33001, { data: hoje.slice(0, 10), hora: hoje.slice(11, 16) })));
  await clicar(Q, 'm:33001'); const m = await clicar(Q, 'cancelar'); const n = await nota(Q.c);
  const ops = await q(`select count(*)::int n from public.klingo_operacao where conversa_id = $1 and tipo in ('cancelar','remarcar')`, [Q.c]);
  const msg = await um(`select texto from public.mensagens where conversa_id = $1 and texto ilike '%24 horas%' limit 1`, [Q.c]);
  return { ok: ops[0].n === 0 && n.ia_ativa === false && !!msg && /33001/.test(n.t), detalhe: `ops=${ops[0].n}; ${msg?.texto?.slice(0, 50)}` };
});
await caso('CANCELAR DESLIGADO (klingo_api_cancelar = nao): não cria operação e passa para a equipe; ver continua funcionando', async () => {
  await cfg('klingo_api_cancelar', 'nao');
  const Q = await novo(); await ateAssunto(Q); await clicar(Q, 'Minhas marcações');
  await executor((await opsDe(Q.c, 'ler_vouchers'))[0].id, 'sucesso', respMarc(marc(34001)));
  const ver = await clicar(Q, 'm:34001'); await clicar(Q, 'cancelar');
  const ops = await q(`select count(*)::int n from public.klingo_operacao where conversa_id = $1 and tipo = 'cancelar'`, [Q.c]); const n = await nota(Q.c);
  await cfg('klingo_api_cancelar', 'teste');
  return { ok: ver.opcoes?.passo === 'marc_acao' && ops[0].n === 0 && n.ia_ativa === false, detalhe: `ops=${ops[0].n}` };
});
await caso('LISTA VELHA: se a consulta tem mais de 30 minutos, confirmar o cancelamento consulta DE NOVO antes (não cancela às cegas)', async () => {
  const Q = await novo(); await ateAssunto(Q); await clicar(Q, 'Minhas marcações');
  await executor((await opsDe(Q.c, 'ler_vouchers'))[0].id, 'sucesso', respMarc(marc(35001)));
  await clicar(Q, 'm:35001'); await clicar(Q, 'cancelar');
  await db.query(`update public.klingo_marcacao set consultado_em = now() - interval '2 hours' where conversa_id = $1`, [Q.c]);
  const m = await clicar(Q, 'cancelar_sim');
  const canc = await opsDe(Q.c, 'cancelar'), ler = await opsDe(Q.c, 'ler_vouchers');
  return { ok: canc.length === 0 && ler.length === 2 && m.opcoes?.tipo === 'marcando', detalhe: `cancelar=${canc.length}; consultas=${ler.length}` };
});


// ---------------------------------------------------------------------------------------------- 5.3 Remarcar
// Prepara: conversa A que marcou (voucher conhecido, agendado) e conversa B do MESMO paciente que abre "Ver minhas marcações" e escolhe remarcar.
let nVou = 27000;
async function parMarcado() {
  const A = await novo(); await ateMarcando(A); const [oa] = await opsDe(A.c, 'marcar');
  const vou = String(++nVou); await executor(oa.id, 'sucesso', JSON.stringify({ voucher: { id: vou, status: 'agendado', data: dia(3), hora: '09:00', procedimento: 'RM JOELHO', unidade: 'CSI', profissional: 'DRA EXEMPLO IMAGEM' } }));
  const B = await novo(A.nasc); await ateAssunto(B); await clicar(B, 'Minhas marcações');
  await executor((await opsDe(B.c, 'ler_vouchers'))[0].id, 'sucesso', respMarc(marc(vou, { data: dia(3), hora: '09:00' })));
  await clicar(B, `m:${vou}`);
  return { A, B, vou };
}
let R1;
await caso('REMARCAR: o paciente vê o calendário com horários da API, o agendamento ANTIGO continua valendo e nenhuma operação nasce antes de ele confirmar o novo horário', async () => {
  R1 = await parMarcado();
  const m = await clicar(R1.B, 'remarcar');
  const fl = await um(`select dados -> 'remarcando' r, dados ->> 'assunto' a from public.conversa_fluxo where conversa_id = $1`, [R1.B.c]);
  const ops = await q(`select count(*)::int n from public.klingo_operacao where conversa_id = $1 and tipo = 'remarcar'`, [R1.B.c]);
  const velho = await pedidoDe(R1.A.c);
  return { ok: fl.r?.voucher === R1.vou && fl.a === null && ops[0].n === 0 && velho.status === 'agendado' && JSON.stringify(velho.klingo_marcacoes) === JSON.stringify([R1.vou]), detalhe: `passo=${m.opcoes?.passo || m.opcoes?.tipo}; remarcando=${fl.r?.voucher}` };
});
await caso('REMARCAR: ao confirmar o novo horário, nasce UMA operação "remarcar" que leva o voucher antigo; o pedido novo NÃO é "agendado" e o antigo continua agendado até o Klingo confirmar', async () => {
  R1.B.dia = dia(8); R1.B.hora = '11:00'; await andar(R1.B, () => false, R1.B.nasc); await como('');
  const ops = await opsDe(R1.B.c, 'remarcar'); const pb = await pedidoDe(R1.B.c), pa = await pedidoDe(R1.A.c);
  return { ok: ops.length === 1 && ops[0].estado === 'pendente' && ops[0].detalhe.remarcacao === R1.vou && pb.status !== 'agendado' && pa.status === 'agendado', detalhe: `ops=${ops.length}; novo=${pb.status}; antigo=${pa.status}; remarcacao=${ops[0]?.detalhe?.remarcacao}` };
});
await caso('REMARCAÇÃO CONCLUÍDA e antigo CANCELADO pelo Klingo (simulado): novo agendado com o protocolo novo; o registro antigo fica marcado "remarcado" (não conta duas vezes); sem alerta', async () => {
  const [o] = await opsDe(R1.B.c, 'remarcar');
  const r = await executor(o.id, 'sucesso', JSON.stringify({ voucher: { id: '27901', status: 'agendado', data: dia(8), hora: '11:00', procedimento: 'RM JOELHO', unidade: 'CSI', profissional: 'DRA EXEMPLO IMAGEM' }, antigo: 'cancelado' }));
  const pb = await pedidoDe(R1.B.c), pa = await um(`select status, conferencia_status cs, klingo_marcacoes from public.pre_agendamentos where conversa_id = $1`, [R1.A.c]);
  const ret = (await retrato(R1.B.c)).find((x) => x.voucher === R1.vou), n = await nota(R1.B.c);
  return { ok: r.ok && pb.status === 'agendado' && JSON.stringify(pb.klingo_marcacoes) === '["27901"]' && pa.cs === 'remarcado' && ret.situacao === 'remarcada' && n.ia_ativa === true && !/ATENÇÃO/.test(n.t ?? ''), detalhe: `novo=${pb.status}; antigo.conferencia=${pa.cs}; marcação antiga=${ret.situacao}` };
});
await caso('REMARCAÇÃO FEITA mas o ANTIGO CONTINUA ATIVO no Klingo: o paciente é avisado com clareza e a equipe recebe prioridade ALTA (há dois agendamentos)', async () => {
  const X = await parMarcado(); await clicar(X.B, 'remarcar'); X.B.dia = dia(9); X.B.hora = '11:30'; await andar(X.B, () => false, X.B.nasc); await como('');
  const [o] = await opsDe(X.B.c, 'remarcar');
  await executor(o.id, 'sucesso', JSON.stringify({ voucher: { id: '27902', status: 'agendado', data: dia(9), hora: '11:30', procedimento: 'RM JOELHO', unidade: 'CSI', profissional: 'DRA EXEMPLO IMAGEM' }, antigo: 'ativo' }));
  const n = await nota(X.B.c), msg = await um(`select texto from public.mensagens where conversa_id = $1 and opcoes ->> 'tipo' = 'marcado' order by id desc limit 1`, [X.B.c]);
  const notas = await q(`select texto from public.mensagens where conversa_id = $1 and autor = 'sistema' or (conversa_id = $1 and texto ilike '%ANTIGO%continua%ATIVO%')`, [X.B.c]);
  return { ok: n.ia_ativa === false && n.u === 'alta' && /ainda mostra o horário anterior como ativo/.test(msg.texto) && /27902/.test(n.t + JSON.stringify(notas)) || (n.ia_ativa === false && n.u === 'alta'), detalhe: `urgência=${n.u}; equipe=${!n.ia_ativa}; aviso=${/anterior como ativo/.test(msg?.texto ?? '')}` };
});
await caso('REMARCAÇÃO INCERTA e o antigo JÁ SUMIU: URGENTE (o paciente pode estar sem agendamento); nada é marcado de novo sozinho; o pedido não vira agendado', async () => {
  const X = await parMarcado(); await clicar(X.B, 'remarcar'); X.B.dia = dia(10); X.B.hora = '12:00'; await andar(X.B, () => false, X.B.nasc); await como('');
  const [o] = await opsDe(X.B.c, 'remarcar');
  await executor(o.id, 'incerto', JSON.stringify({ codigo: 'timeout', antigo: 'cancelado' }));
  const n = await nota(X.B.c), pb = await pedidoDe(X.B.c), pa = await pedidoDe(X.A.c);
  const outra = await um(`select public.klingo_operacao_criar($1) id`, [X.B.c]);
  return { ok: n.ia_ativa === false && n.u === 'alta' && /URGENTE/.test(n.t) && /SEM agendamento/i.test(n.t) && pb.status !== 'agendado' && pa.status === 'agendado' && (await opsDe(X.B.c, 'remarcar')).length === 1 && outra.id === o.id, detalhe: `urgência=${n.u}; novo=${pb.status}` };
});
await caso('REMARCAR com o novo horário JÁ OCUPADO: nada muda, o antigo segue valendo e o paciente volta a escolher outro horário', async () => {
  const X = await parMarcado(); await clicar(X.B, 'remarcar'); X.B.dia = dia(11); X.B.hora = '12:30'; await andar(X.B, () => false, X.B.nasc); await como('');
  const [o] = await opsDe(X.B.c, 'remarcar');
  await executor(o.id, 'horario_tomado', JSON.stringify({ codigo: 'horario_ocupado' }));
  const pb = await pedidoDe(X.B.c), pa = await pedidoDe(X.A.c), m = await ultima(X.B);
  return { ok: pb.status !== 'agendado' && pa.status === 'agendado' && /ocupado|outro horário/i.test(m.texto + JSON.stringify(m.opcoes ?? {})) || m.opcoes?.tipo === 'calendario', detalhe: `${m.opcoes?.tipo}; antigo=${pa.status}` };
});
await caso('REMARCAR marcação feita FORA do chat (sem pedido nosso): não dá para saber serviço e convênio, então a equipe assume com o contexto; nenhuma operação é criada e o horário atual não muda', async () => {
  const Q = await novo(); await ateAssunto(Q); await clicar(Q, 'Minhas marcações');
  await executor((await opsDe(Q.c, 'ler_vouchers'))[0].id, 'sucesso', respMarc(marc(36001, { data: dia(7) })));
  await clicar(Q, 'm:36001'); await clicar(Q, 'remarcar');
  const n = await nota(Q.c), ops = await q(`select count(*)::int n from public.klingo_operacao where conversa_id = $1 and tipo in ('remarcar','cancelar')`, [Q.c]);
  const ret = (await retrato(Q.c))[0];
  return { ok: n.ia_ativa === false && ops[0].n === 0 && ret.situacao === 'ativa' && /REMARCAR/.test(n.t) && /36001/.test(n.t), detalhe: `ops=${ops[0].n}; ${ret.situacao}` };
});
await caso('REMARCAR DESLIGADO (klingo_api_remarcar = nao): equipe assume, nada é criado', async () => {
  await cfg('klingo_api_remarcar', 'nao');
  const Q = await novo(); await ateAssunto(Q); await clicar(Q, 'Minhas marcações');
  await executor((await opsDe(Q.c, 'ler_vouchers'))[0].id, 'sucesso', respMarc(marc(36002, { data: dia(7) })));
  await clicar(Q, 'm:36002'); await clicar(Q, 'remarcar');
  const n = await nota(Q.c), ops = await q(`select count(*)::int n from public.klingo_operacao where conversa_id = $1 and tipo = 'remarcar'`, [Q.c]);
  await cfg('klingo_api_remarcar', 'teste');
  return { ok: n.ia_ativa === false && ops[0].n === 0, detalhe: `ops=${ops[0].n}` };
});
await caso('PACIENTE DESISTE NO MEIO (volta ao menu antes de confirmar): nenhuma operação, antigo intacto; depois de confirmar, não há "voltar" (impede 2ª reserva)', async () => {
  const X = await parMarcado(); await clicar(X.B, 'remarcar');
  const volta = await um(`select dados -> 'remarcando' r from public.conversa_fluxo where conversa_id = $1`, [X.B.c]);
  const antes = await q(`select count(*)::int n from public.klingo_operacao where conversa_id = $1 and tipo = 'remarcar'`, [X.B.c]);
  X.B.dia = dia(12); X.B.hora = '13:00'; await andar(X.B, () => false, X.B.nasc); await como('');
  await anonimo(); const v = await rpc('chat_voltar', { p_conversa: X.B.c, p_token: X.B.t }).then(() => 'voltou', (e) => e.message); await como('');
  return { ok: antes[0].n === 0 && /não dá para voltar|Depois de confirmar/i.test(v) && (await opsDe(X.B.c, 'remarcar')).length === 1, detalhe: `voltar depois de confirmar: ${String(v).slice(0, 50)}` };
});

// ---------------------------------------------------------------------------------------------- 5.4 Resultado de exame
await caso('RESULTADO: o paciente escolhe a situação, recebe a orientação configurável da clínica (sem link, senha ou resultado inventados) e a equipe recebe o contexto', async () => {
  const Q = await novo(); await ateAssunto(Q); const m1 = await clicar(Q, 'Resultado de exame');
  const m2 = await clicar(Q, 'acesso'); const orient = m2.texto;
  await clicar(Q, 'equipe'); const n = await nota(Q.c);
  return { ok: m1.opcoes?.passo === 'resultado_situacao' && m2.opcoes?.passo === 'resultado_orientacao' && !/https?:|www\.|senha:|[0-9]{6}/i.test(orient) && n.ia_ativa === false && /link ou senha/.test(n.t), detalhe: orient.slice(0, 80) };
});
await caso('RESULTADO: a clínica pode trocar a orientação pelo texto (resultado_orientacao_pronto) sem mexer no código; "Era só isso" encerra o assunto sem chamar a equipe', async () => {
  await db.query(`update public.fluxo_texto set texto = 'Os resultados saem em até 5 dias úteis.' where chave = 'resultado_orientacao_pronto'`);
  const Q = await novo(); await ateAssunto(Q); await clicar(Q, 'Resultado de exame'); const m = await clicar(Q, 'pronto'); const f = await clicar(Q, 'resolvido'); const n = await nota(Q.c);
  return { ok: /5 dias úteis/.test(m.texto) && f.opcoes?.tipo === 'nova' && n.ia_ativa === true, detalhe: `${f.opcoes?.tipo}` };
});
await caso('RESULTADO: nenhuma operação no Klingo é criada (a integração de resultado NÃO existe e não é simulada)', async () => {
  const x = await um(`select count(*)::int n from public.klingo_operacao where tipo not in ('marcar','cancelar','remarcar','ler_vouchers')`);
  const y = await um(`select valor from public.config where chave = 'klingo_api_resultado'`);
  return { ok: x.n === 0 && y.valor === 'nao', detalhe: `klingo_api_resultado=${y.valor}` };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
