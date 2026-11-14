// FLUXOGRAMA: entrada (clone da produção + partes 1 e 2; paciente de mentira na lista de teste; Klingo SIMULADO: o teste faz o papel do executor chamando klingo_operacao_pegar/concluir) -> validação (do calendário à confirmação pelas funções reais do chat)
//   -> processamento (marcação por oferta, duplo clique, 2 chamadas, incerto, horário tomado, retentativa do job, divergência de cadastro, plano sem tradução, vários exames, transferência humana) -> persistência (só no clone) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Grupo B do prompt mestre sobre o pipeline que JÁ existe (klingo_operacao / klingo-executar): prova idempotência e que "agendado" só nasce de confirmação com voucher. NÃO fala com o Klingo real.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste'), ('klingo_interno_segredo', 'interno-de-teste')`);
let sqlErro = null;
for (const f of ['webchat-v2-parte1-modos', 'webchat-v2-parte2-calendario-api']) { try { await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8')); } catch (e) { sqlErro = `${f}: ${String(e.message).split('\n')[0]}`; } }
registrar('o retrato da produção monta inteiro e as partes 1 e 2 aplicam sem erro', falhas.length === 0 && !sqlErro, sqlErro ?? '');

const UNIDADE = 'CLÍNICA DE SAÚDE E IMAGEM - CSI', TESTE = '71988880077';
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
      const d = dia(3), chave = `${d}|63|308|2|09:00`;
      await como('');   // oferta e registro da consulta são do sistema (service_role), não do paciente
      await db.query(`select public.klingo_oferta_gravar_v2($1, 201, 1, $2::jsonb, false, true)`, [p.c, JSON.stringify([{ chave, data: d, hora: '09:00', profissional: 'DRA EXEMPLO IMAGEM', unidade: UNIDADE }])]);
      await db.query(`select public.klingo_consulta_registrar($1, 'teste', 'exame', 201, 1, 'ok_com_horarios', 200, 1, 1, 0, 1, 500, null)`, [p.c]);
      await anonimo(); x = await rpc('chat_horario_escolher', { p_conversa: p.c, p_token: p.t, p_grupo: 1, p_data: d, p_hora: '09:00', p_unidade: UNIDADE });
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

let A, op;
await caso('MARCAÇÃO BEM-SUCEDIDA (passo 1): ao confirmar, nasce UMA operação "pendente" sem dado pessoal; o pedido AINDA NÃO está agendado; o executor é chamado só com o id', async () => {
  A = await novo(); await ateMarcando(A);
  const ops = await opDe(A.c), pa = await pedidoDe(A.c), ch = await q(`select body, headers from net.chamadas where url like '%klingo-executar' order by id desc limit 1`);
  op = ops[0];
  const pii = JSON.stringify(ops).match(/11144477735|Maria|1980|maria@/i);
  return { ok: ops.length === 1 && op.estado === 'pendente' && op.tipo === 'marcar' && pa.status !== 'agendado' && !pii && ch[0] && Object.keys(ch[0].body).join() === 'operacao_id' && ch[0].headers['x-klingo-segredo'] === 'interno-de-teste', detalhe: `operações=${ops.length}/${op?.estado}; pedido=${pa.status}; corpo da chamada=${ch[0] && Object.keys(ch[0].body)}` };
});
await caso('DUPLO CLIQUE: criar a operação de novo devolve a MESMA e não chama o executor outra vez; UNIQUE no banco impede a segunda linha mesmo por caminho direto', async () => {
  const antes = await chamadasExecutor();
  const r = await um(`select public.klingo_operacao_criar($1) id`, [A.c]);
  const direto = await db.query(`insert into public.klingo_operacao (conversa_id, tipo, chave_idem) values ($1, 'marcar', $2)`, [A.c, op.chave_idem]).then(() => 'inseriu', (e) => e.code);
  return { ok: r.id === op.id && (await chamadasExecutor()) === antes && (await opDe(A.c)).length === 1 && direto === '23505', detalhe: `mesma operação=${r.id === op.id}; inserção direta duplicada=${direto}` };
});
await caso('DUAS CHAMADAS AO MESMO TEMPO: o executor só pega a operação UMA vez (a 2ª recebe "nao_pendente")', async () => {
  const [a, b] = await Promise.all([um(`select public.klingo_operacao_pegar($1) r`, [op.id]), um(`select public.klingo_operacao_pegar($1) r`, [op.id])]);
  const ok1 = [a.r.ok, b.r.ok].filter(Boolean).length === 1 && [a.r, b.r].some((x) => x.motivo === 'nao_pendente');
  return { ok: ok1 && (await opDe(A.c))[0].tentativas === 1, detalhe: `pegaram=${[a.r.ok, b.r.ok]}` };
});
await caso('SUCESSO COMPROVADO: só com o voucher do Klingo o pedido vira "agendado" (origem chat_api, protocolo guardado) e o paciente recebe o cartão; concluir de novo é inofensivo', async () => {
  const r = (await um(`select public.klingo_operacao_concluir($1, 'sucesso', $2::jsonb) r`, [op.id, sucessoApi(A.c, { id: '26777' })])).r;
  const pa = await pedidoDe(A.c), msg = await um(`select texto, opcoes from public.mensagens where conversa_id = $1 and opcoes ->> 'tipo' = 'marcado' order by id desc limit 1`, [A.c]);
  const rep = (await um(`select public.klingo_operacao_concluir($1, 'sucesso', '{}'::jsonb) r`, [op.id])).r;
  return { ok: r.ok && pa.status === 'agendado' && pa.agendado_origem === 'chat_api' && JSON.stringify(pa.klingo_marcacoes) === '["26777"]' && msg?.opcoes?.voucher?.id === '26777' && rep.repetido === true && (await opDe(A.c)).length === 1, detalhe: `pedido=${pa.status}/${pa.agendado_origem}; protocolo=${pa.klingo_marcacoes}; repetição=${rep.repetido}` };
});
await caso('REABERTURA / NOVA TENTATIVA depois de agendado não cria 2ª marcação: criar de novo devolve a operação concluída', async () => {
  const r = await um(`select public.klingo_operacao_criar($1) id`, [A.c]);
  return { ok: r.id === op.id && (await opDe(A.c)).length === 1, detalhe: `operações=${(await opDe(A.c)).length}` };
});

let B;
await caso('TIMEOUT / RESULTADO INCERTO: o pedido NÃO vira agendado, a equipe é chamada com "conferir ANTES de marcar de novo", e nova tentativa NÃO cria outra operação', async () => {
  B = await novo(); await ateMarcando(B);
  const [ob] = await opDe(B.c);
  await um(`select public.klingo_operacao_pegar($1)`, [ob.id]);
  await db.query(`select public.klingo_operacao_concluir($1, 'incerto', '{"codigo":"timeout"}'::jsonb)`, [ob.id]);
  const pa = await pedidoDe(B.c), cv = await conversaDe(B.c), nota = await um(`select triagem_resumo t from public.conversas where id = $1`, [B.c]);
  const outra = await um(`select public.klingo_operacao_criar($1) id`, [B.c]);
  return { ok: pa.status !== 'agendado' && cv.ia_ativa === false && /ANTES de marcar de novo/.test(nota.t ?? '') && outra.id === ob.id && (await opDe(B.c)).length === 1, detalhe: `pedido=${pa.status}; ia_ativa=${cv.ia_ativa}; operações=${(await opDe(B.c)).length}` };
});
await caso('RETENTATIVA DO JOB: operação parada é refeita (mesma operação, sem duplicar) e, esgotadas as tentativas, vira INCERTA e vai para a equipe; nunca fica presa', async () => {
  const C = await novo(); await ateMarcando(C);
  const [oc] = await opDe(C.c);
  await db.query(`update public.klingo_operacao set criado_em = now() - interval '2 minutes' where id = $1`, [oc.id]);
  const antes = await chamadasExecutor(); const r1 = (await um(`select public.klingo_operacao_vigiar() r`)).r;
  await db.query(`update public.klingo_operacao set tentativas = 3, criado_em = now() - interval '5 minutes' where id = $1`, [oc.id]);
  const r2 = (await um(`select public.klingo_operacao_vigiar() r`)).r;
  const [dep] = await opDe(C.c), pa = await pedidoDe(C.c);
  return { ok: r1.redisparadas >= 1 && (await chamadasExecutor()) > antes && r2.incertas >= 1 && dep.estado === 'incerto' && pa.status !== 'agendado' && (await opDe(C.c)).length === 1, detalhe: `redisparadas=${r1.redisparadas}; depois=${dep.estado}; operações=${(await opDe(C.c)).length}` };
});
await caso('HORÁRIO OCUPADO NA HORA DE MARCAR: a oferta é descartada, o pedido volta à escolha do horário, nada fica "agendado" e nada vai para a equipe', async () => {
  const D = await novo(); await ateMarcando(D);
  const [od] = await opDe(D.c);
  await um(`select public.klingo_operacao_pegar($1)`, [od.id]);
  await db.query(`select public.klingo_operacao_concluir($1, 'horario_tomado', '{"codigo":"horario_ocupado","http_status":400}'::jsonb)`, [od.id]);
  const pa = await pedidoDe(D.c), of = (await um(`select count(*)::int n from public.klingo_oferta where conversa_id = $1 and not sombra`, [D.c])).n, f = await um(`select passo from public.conversa_fluxo where conversa_id = $1`, [D.c]), cv = await conversaDe(D.c);
  return { ok: pa.status !== 'agendado' && !pa.escolha_horario && of === 0 && f.passo === 'horario' && cv.ia_ativa === true, detalhe: `pedido=${pa.status}; ofertas=${of}; passo=${f.passo}` };
});
await caso('FALHA DEFINITIVA (plano inativo): não vira agendado; a equipe resolve o convênio com o motivo no resumo', async () => {
  const E = await novo(); await ateMarcando(E);
  const [oe] = await opDe(E.c);
  await um(`select public.klingo_operacao_pegar($1)`, [oe.id]);
  await db.query(`select public.klingo_operacao_concluir($1, 'falha', '{"codigo":"plano_inativo","http_status":403}'::jsonb)`, [oe.id]);
  const pa = await pedidoDe(E.c), cv = await conversaDe(E.c);
  return { ok: pa.status !== 'agendado' && cv.ia_ativa === false, detalhe: `pedido=${pa.status}; ia_ativa=${cv.ia_ativa}` };
});
await caso('CPF DIVERGENTE: o cadastro do Klingo tem outra data de nascimento => NENHUMA operação é criada; a equipe assume', async () => {
  const F = await novo();
  await andar(F, (o) => o.passo === 'confirmar', F.nasc); await como('');
  await db.query(`select public.klingo_identidade_registrar('11144477735', $1::date, '{"situacao":"divergente"}'::jsonb, $2)`, [F.nasc.split('/').reverse().join('-'), F.c]);
  const pode = (await um(`select public.klingo_pode_marcar($1) r`, [F.c])).r;
  await andar(F, () => false, F.nasc); await como('');
  return { ok: pode.ok === false && pode.motivo === 'cadastro_divergente' && (await opDe(F.c)).length === 0 && (await pedidoDe(F.c)).status !== 'agendado', detalhe: `motivo=${pode.motivo}; operações=${(await opDe(F.c)).length}` };
});
await caso('PLANO SEM TRADUÇÃO / PACIENTE NOVO sem chave de pré-cadastro / VÁRIOS EXAMES: klingo_pode_marcar recusa com o motivo certo e nenhuma operação nasce', async () => {
  const G = await novo(); await andar(G, (o) => o.passo === 'confirmar', G.nasc); await como('');
  await db.query(`select public.klingo_identidade_registrar('11144477735', $1::date, '{"situacao":"confere","klingo_id":"P1"}'::jsonb, $2)`, [G.nasc.split('/').reverse().join('-'), G.c]);   // cadastro conferido: agora a tradução do plano é exigida
  await cfg('klingo_api_exame_convenio', 'sim');   // para o teste chegar até a tradução do plano (hoje exame com convênio já é recusado antes)
  await db.query(`update public.pre_agendamentos set plano = 'Convenio Fantasma' where conversa_id = $1`, [G.c]);
  const semPlano = (await um(`select public.klingo_pode_marcar($1) r`, [G.c])).r;
  await cfg('klingo_api_exame_convenio', 'nao');
  await db.query(`update public.pre_agendamentos set plano = 'Particular' where conversa_id = $1`, [G.c]);
  await db.query(`select public.klingo_identidade_registrar('11144477735', $1::date, '{"situacao":"nao_encontrado"}'::jsonb, $2)`, [G.nasc.split('/').reverse().join('-'), G.c]);
  await cfg('klingo_api_pre_cadastro', 'nao'); const novoPac = (await um(`select public.klingo_pode_marcar($1) r`, [G.c])).r; await cfg('klingo_api_pre_cadastro', 'teste');
  await db.query(`select public.klingo_identidade_registrar('11144477735', $1::date, '{"situacao":"confere","klingo_id":"P1"}'::jsonb, $2)`, [G.nasc.split('/').reverse().join('-'), G.c]);
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, lado, procedimento_id, procedimento) values ($1, 'RM', 'joelho', 'E', 201, 'RM JOELHO ESQ')`, [G.c]);
  const varios = (await um(`select public.klingo_pode_marcar($1) r`, [G.c])).r;
  return { ok: semPlano.ok === false && /sem_traducao|sem_plano|plano/.test(semPlano.motivo) && novoPac.ok === false && novoPac.motivo === 'paciente_novo' && varios.ok === false && varios.motivo === 'varios_procedimentos' && (await opDe(G.c)).length === 0,
           detalhe: `sem tradução=${semPlano.motivo}; paciente novo=${novoPac.motivo}; vários exames=${varios.motivo}` };
});
await caso('OFERTA DE SOMBRA / HORÁRIO DA GRADE nunca servem de base: sem oferta real klingo_pode_marcar devolve "sem_oferta_da_api"', async () => {
  const H = await novo(); await andar(H, (o) => o.passo === 'confirmar', H.nasc); await como('');
  await db.query(`update public.klingo_oferta set sombra = true where conversa_id = $1`, [H.c]);
  const sombra = (await um(`select public.klingo_pode_marcar($1) r`, [H.c])).r;
  await db.query(`delete from public.klingo_oferta where conversa_id = $1`, [H.c]);
  const sem = (await um(`select public.klingo_pode_marcar($1) r`, [H.c])).r;
  return { ok: sombra.ok === false && sombra.motivo === 'sem_oferta_da_api' && sem.ok === false && sem.motivo === 'sem_oferta_da_api', detalhe: `sombra=${sombra.motivo}; apagada=${sem.motivo}` };
});
await caso('PACIENTE COMUM (fora da lista de teste, mestre "sim" + marcar "teste"): NÃO há operação nem marcação automática; o pedido vai à equipe', async () => {
  await cfg('klingo_api_telefones_teste', TESTE);   // tira os telefones criados pelos casos acima da lista
  const J = await novo(nascUnico(), telefone()); await cfg('klingo_api_telefones_teste', TESTE);
  await andar(J, (o) => o.tipo === 'calendario', J.nasc).catch(() => {}); await como('');
  const pode = (await um(`select public.klingo_pode_marcar($1) r`, [J.c])).r, modo = (await um(`select public.klingo_modo($1, 'klingo_api_marcar') m`, [J.c])).m;
  return { ok: pode.ok === false && pode.motivo === 'desligado' && modo === 'nao' && (await opDe(J.c)).length === 0, detalhe: `klingo_pode_marcar=${pode.motivo}; modo=${modo}` };
});
await caso('TRANSFERÊNCIA HUMANA COM OPERAÇÃO EM ANDAMENTO / DEPOIS DE AGENDAR: a rotina NÃO encerra sozinha uma conversa que já teve atendente', async () => {
  await db.query(`update public.conversas set primeiro_humano_em = now() - interval '5 hours' where id = $1`, [A.c]);
  await db.query(`update public.pre_agendamentos set agendado_auto_em = now() - interval '5 hours' where conversa_id = $1`, [A.c]);
  await um(`select public.klingo_operacao_vigiar() r`);
  const cv = await conversaDe(A.c);
  return { ok: cv.status !== 'encerrada', detalhe: `status=${cv.status}` };
});

console.log(`\n${resultados.filter(Boolean).length} de ${resultados.length} verificações passaram.`);
process.exit(resultados.every(Boolean) ? 0 : 1);
