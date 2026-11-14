// FLUXOGRAMA: entrada (clone da produção + partes 1, 2 e 5 + a configuração pública de supabase/webchat-v2-config-publica.sql; pacientes de mentira com telefone FORA de qualquer lista) -> validação (modo efetivo de cada capacidade para o público)
//   -> processamento (cada chave decide a sua capacidade; mestre nao desliga tudo; mestre teste limita; sombra/teste nunca viram sim) -> persistência (só no clone) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Decisão do dono (14/11/2026): agendamento automático para TODOS. Prova que, com a configuração pública, o público comum recebe cada capacidade e que as chaves continuam independentes.
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
registrar('o retrato da produção monta inteiro e as partes 1, 2 e 5 e a configuração pública aplicam sem erro', falhas.length === 0 && !sqlErro, sqlErro ?? '');

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
// configuração pública aplicada DEPOIS dos dados de partida (que repetem o estado de hoje da produção: chaves em teste/sombra)
let pubErro = null; try { await db.exec(readFileSync(`${REPO}/supabase/webchat-v2-config-publica.sql`, 'utf8')); } catch (e) { pubErro = String(e.message).split('\n')[0]; }
registrar('a configuração pública aplica sem erro (e reaplicar é inofensivo)', !pubErro, pubErro ?? '');
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
// Público geral: telefone que NÃO está em nenhuma lista
// =============================================================================================================================================================
const ultima = async (p) => { await como(''); const m = await um(`select id, texto, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [p.c]); p.ult = m; return m; };
const comum = async (nasc = nascUnico()) => { await anonimo(); const tel = '7198' + String(8000000 + ++nTel); const r = await rpc('chat_iniciar', { p_nome: 'Maria Teste da Silva', p_telefone: tel, p_email: 'maria@exemplo.invalid', p_aceite: true, p_paciente_tipo: 'proprio' }); await como(''); return { c: r.conversa_id, t: r.token, tel, nasc, ult: r.respostas.at(-1) }; };
const modo = async (c, k) => (await um(`select public.klingo_modo($1, $2) m`, [c, k])).m;
const CAPACIDADES = ['klingo_api_horarios', 'klingo_api_marcar', 'klingo_api_pre_cadastro', 'klingo_api_consultar', 'klingo_api_cancelar', 'klingo_api_remarcar', 'previsao_modo', 'notificacao_modo', 'previsao_monitor_modo'];
let X;
await caso('PÚBLICO: paciente fora de qualquer lista tem TODAS as capacidades em "sim" com a configuração pública (e a lista de teste está vazia de efeito)', async () => {
  X = await comum(); const m = {}; for (const k of CAPACIDADES) m[k] = await modo(X.c, k);
  return { ok: CAPACIDADES.every((k) => m[k] === 'sim'), detalhe: JSON.stringify(m) };
});
await caso('PÚBLICO: o mestre NÃO é o que libera: com o mestre em "teste" o público fica sem nada (teto) e com "nao" nem a lista de teste usa; "sim" volta tudo', async () => {
  await cfg('klingo_auto', 'teste'); const t = await modo(X.c, 'klingo_api_marcar'); await cfg('klingo_auto', 'nao'); const n = await modo(X.c, 'klingo_api_horarios'); await cfg('klingo_auto', 'sim'); const s = await modo(X.c, 'klingo_api_marcar');
  return { ok: t === 'nao' && n === 'nao' && s === 'sim', detalhe: `teste→${t}; nao→${n}; sim→${s}` };
});
await caso('PÚBLICO: as chaves são independentes: desligar só o cancelamento não mexe em marcar, ver, remarcar nem horários', async () => {
  await cfg('klingo_api_cancelar', 'nao'); const m = {}; for (const k of CAPACIDADES) m[k] = await modo(X.c, k); await cfg('klingo_api_cancelar', 'sim');
  return { ok: m.klingo_api_cancelar === 'nao' && CAPACIDADES.filter((k) => k !== 'klingo_api_cancelar').every((k) => m[k] === 'sim'), detalhe: JSON.stringify(m) };
});
await caso('SEM O COMPORTAMENTO ANTIGO: "teste" e "sombra" nunca são lidos como "sim" nem com o mestre em "sim"', async () => {
  await cfg('klingo_api_marcar', 'teste'); await cfg('klingo_api_horarios', 'sombra');
  const a = await modo(X.c, 'klingo_api_marcar'), b = await modo(X.c, 'klingo_api_horarios'), c = (await um(`select public.klingo_ativo($1, 'klingo_api_horarios') a`, [X.c])).a;
  await cfg('klingo_api_marcar', 'sim'); await cfg('klingo_api_horarios', 'sim');
  return { ok: a === 'nao' && b === 'sombra' && c === false, detalhe: `marcar=teste→${a}; horarios=sombra→${b}; ativo=${c}` };
});
await caso('PÚBLICO: o menu de assunto oferece "Ver minhas marcações" para o público comum e a consulta ao Klingo é pedida (operação ler_vouchers)', async () => {
  const P = await comum(); const ate = async () => { for (let i = 0; i < 30; i++) { const m = await ultima(P), o = m.opcoes; if (o?.passo === 'assunto') return m; await anonimo(); if (o?.tipo === 'campos') { const v = {}; for (const cp of o.campos || []) v[cp.nome] = cp.tipo === 'data' ? P.nasc : CAMPO(cp); await rpc('chat_responder', { p_conversa: P.c, p_token: P.t, p_passo: o.passo, p_valor: v, p_texto: null }); } else { const v = o.passo === 'motivo' ? 'assunto' : o.itens[0].valor; await rpc('chat_responder', { p_conversa: P.c, p_token: P.t, p_passo: o.passo, p_valor: JSON.stringify(v), p_texto: String(v) }); } await como(''); } throw new Error('sem assunto'); };
  const menu = await ate(); await anonimo(); await rpc('chat_responder', { p_conversa: P.c, p_token: P.t, p_passo: 'assunto', p_valor: JSON.stringify('Minhas marcações'), p_texto: 'x' }); await como('');
  const ops = await q(`select tipo, estado from public.klingo_operacao where conversa_id = $1`, [P.c]);
  return { ok: (menu.opcoes.itens || []).some((i) => i.valor === 'Minhas marcações') && ops.length === 1 && ops[0].tipo === 'ler_vouchers', detalhe: `ops=${JSON.stringify(ops)}` };
});
await caso('PÚBLICO: a marcação automática segue o pipeline protegido (operação pendente sem dado pessoal; "agendado" só com o voucher do Klingo)', async () => {
  const P = await comum(); await andar(P, () => false, P.nasc); await como('');
  const ops = await q(`select id, tipo, estado, detalhe from public.klingo_operacao where conversa_id = $1`, [P.c]);
  const pa = await um(`select status from public.pre_agendamentos where conversa_id = $1`, [P.c]);
  const pii = JSON.stringify(ops).match(/11144477735|Maria|maria@/i);
  return { ok: ops.length === 1 && ops[0].tipo === 'marcar' && ops[0].estado === 'pendente' && pa.status !== 'agendado' && !pii, detalhe: `${ops[0]?.tipo}/${ops[0]?.estado}; pedido=${pa.status}` };
});
await caso('PÚBLICO: o calendário do paciente comum mostra EXATAMENTE as ofertas da API (a grade não é vaga)', async () => {
  const P = await comum(); await andar(P, (o) => o.tipo === 'calendario', P.nasc); await como('');
  const d = dia(4); await db.query(`select public.klingo_oferta_gravar_v2($1, 201, 1, $2::jsonb, false, true)`, [P.c, JSON.stringify([{ chave: `${d}|63|308|2|10:30`, data: d, hora: '10:30', profissional: 'DRA EXEMPLO IMAGEM', unidade: UNIDADE }])]);
  await db.query(`select public.klingo_consulta_registrar($1, 'sim', 'exame', 201, 1, 'ok_com_horarios', 200, 1, 1, 0, 1, 500, null)`, [P.c]);
  await anonimo(); const r = await rpc('chat_horarios', { p_conversa: P.c, p_token: P.t, p_grupo: 1, p_de: dia(0), p_ate: dia(40) }); await como('');
  const slots = (r.dias || []).flatMap((x) => x.slots.map((s) => `${x.data} ${s.hora}`));
  return { ok: r.estado === 'com_horarios' && slots.length === 1 && slots[0] === `${d} 10:30` && r.origem === 'api_klingo', detalhe: `estado=${r.estado}; slots=${slots.join(',')}` };
});
await caso('PÚBLICO: sem consulta à API não há calendário nem vaga inventada (estado "sem_consulta")', async () => {
  const P = await comum(); await andar(P, (o) => o.tipo === 'calendario', P.nasc); await como('');
  await anonimo(); const r = await rpc('chat_horarios', { p_conversa: P.c, p_token: P.t, p_grupo: 1, p_de: dia(0), p_ate: dia(40) }); await como('');
  return { ok: r.estado === 'sem_consulta' && (r.dias || []).length === 0, detalhe: `estado=${r.estado}` };
});

await caso('PÚBLICO: depois de marcar pelo chat, o menu oferece "Cancelar" e "Remarcar" pelas chaves próprias (klingo_api_pos antigo em "teste" não esconde nada); cada botão some se a sua chave for desligada', async () => {
  const marcar = async () => { const P = await comum(); await andar(P, () => false, P.nasc); await como(''); const [o] = await q(`select id from public.klingo_operacao where conversa_id = $1 and tipo = 'marcar'`, [P.c]);
    await um(`select public.klingo_operacao_pegar($1)`, [o.id]); await db.query(`select public.klingo_operacao_concluir($1, 'sucesso', $2::jsonb)`, [o.id, sucessoApi(P.c, { id: String(28000 + (++nTel)) })]);
    return um(`select opcoes from public.mensagens where conversa_id = $1 and opcoes ->> 'passo' = 'pos_menu' order by id desc limit 1`, [P.c]); };
  await cfg('klingo_api_pos', 'teste');
  const a = (await marcar()).opcoes.itens.map((i) => i.valor);
  await cfg('klingo_api_cancelar', 'nao'); await cfg('klingo_api_remarcar', 'nao');
  const b = (await marcar()).opcoes.itens.map((i) => i.valor);
  await cfg('klingo_api_cancelar', 'sim'); await cfg('klingo_api_remarcar', 'sim');
  return { ok: a.includes('cancelar') && a.includes('remarcar') && !b.includes('cancelar') && !b.includes('remarcar') && b.includes('equipe'), detalhe: `ligadas=${a}; desligadas=${b}` };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
