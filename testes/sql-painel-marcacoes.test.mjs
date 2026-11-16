// FLUXOGRAMA: entrada (clone da produção + partes 1 a 3 do WebChat v2 + supabase/painel-marcacoes.sql; paciente de mentira; o executor do Klingo é simulado chamando klingo_operacao_concluir) -> validação (só admin/atendente; chaves da conversa ligadas; dados do paciente completos; só cancela voucher visto há menos de 10 min)
//   -> processamento (ver marcações, cancelar, falha, incerto) -> persistência (só no clone) -> saída (PASS/FAIL). O PACIENTE NÃO RECEBE MENSAGEM por este caminho.
// Versão 1.0 — 16/11/2026 / Mudança: primeira versão (Etapa 3: ver e cancelar marcações pelo painel).
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste'), ('klingo_interno_segredo', 'interno-de-teste')`);
let sqlErro = null;
for (const f of ['webchat-v2-parte1-modos', 'webchat-v2-parte2-calendario-api', 'webchat-v2-parte3-disponibilidade-futura', 'painel-ofertas', 'painel-marcacoes']) {
  try { await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8')); } catch (e) { sqlErro = `${f}: ${String(e.message).split('\n')[0]}`; }
}
registrar('o retrato da produção monta inteiro e as partes 1 a 3 do WebChat v2 e a painel-marcacoes aplicam sem erro', falhas.length === 0 && !sqlErro, sqlErro ?? '');

const ADMIN = '00000000-0000-4000-8000-0000000000a1', ATEND = '00000000-0000-4000-8000-0000000000a2', NAOEQUIPE = '00000000-0000-4000-8000-0000000000b1';
const UNIDADE = 'CLÍNICA DE SAÚDE E IMAGEM - CSI';
await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}', 'admin@exemplo.invalid'), ('${ATEND}', 'atendente@exemplo.invalid'), ('${NAOEQUIPE}', 'paciente@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADMIN}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true), ('${ATEND}', 'Ana Atendente', 'atendente@exemplo.invalid', 'atendente', true);
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!'), ('reabrir_dias', '2') on conflict (chave) do update set valor = excluded.valor;
  insert into public.catalogo_regiao (codigo, nome, padrao, tem_lado, grupo, ordem) values ('joelho', 'Joelho', 'JOELHO', true, 'perna', 1);
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values (201, 'RESSONANCIA MAGNETICA DO JOELHO (UNILATERAL)', 'RESSONANCIA MAGNETICA', true, 9, '');
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 201, 'RM JOELHO', '${UNIDADE}', 'RESSONANCIA', 'DRA EXEMPLO IMAGEM', 'RADIOLOGIA', d, '08:00', '12:00', 30, current_date - 30, current_date + 300 from generate_series(0, 6) d;
`);
const cfg = (chave, valor) => db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);
const dia = (n) => new Date(Date.now() + n * 864e5).toLocaleString('sv-SE', { timeZone: 'America/Bahia' }).slice(0, 10);
const dow = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
const TESTE = '71900000001';
const CAMPO = (c) => (c.tipo === 'sexo' ? 'F' : c.tipo === 'data' ? '25/03/1980' : c.tipo === 'cpf' ? '111.444.777-35' : c.tipo === 'tel' ? '(71) 99999-0001' : c.tipo === 'email' ? 'maria@exemplo.invalid'
  : c.tipo === 'cep' ? '40000-000' : c.tipo === 'uf' ? 'BA' : c.nome === 'nome' ? 'Maria Teste da Silva' : c.nome === 'mae' ? 'Ana Teste da Silva' : c.nome === 'numero' ? '10' : 'Texto de teste');
let nTel = 0;
const telefone = () => '7198' + String(5000000 + ++nTel);
const rpc = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  const r = await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k])));
  return r[0].r;
};
const comoPaciente = async (fn) => { await anonimo(); try { return await fn(); } finally { await como(''); } };
const erroDe = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, msg: String(e.message).split('\n')[0] }; } };
const lista = new Set([TESTE]);
const ativar = (p) => { lista.add(p.tel); return cfg('klingo_api_telefones_teste', [...lista].join(',')); };
let nNasc = 0;
const nascUnico = () => { nNasc++; return `${String(1 + (nNasc % 27)).padStart(2, '0')}/${String(1 + (nNasc % 11)).padStart(2, '0')}/${1950 + nNasc}`; };   // cada paciente de mentira é uma PESSOA diferente (a mesma pessoa cai na mesma solicitação)
async function ateOCalendario(nasc = nascUnico()) {
  const tel = telefone();
  await anonimo();
  const r = await rpc('chat_iniciar', { p_nome: 'Maria Teste da Silva', p_telefone: tel, p_email: 'maria@exemplo.invalid', p_aceite: true, p_paciente_tipo: 'proprio' });
  const p = { c: r.conversa_id, t: r.token, tel, ult: r.respostas.at(-1) };
  for (let i = 0; i < 30; i++) {
    const o = p.ult.opcoes;
    if (!o || o.tipo === 'calendario' || o.tipo === 'acompanhar') break;
    await anonimo();
    let x;
    if (o.tipo === 'escolha') { const it = (o.itens || [])[0]; x = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify(it.valor), p_texto: it.rotulo }); }
    else if (o.tipo === 'campos') { const v = {}; for (const cp of o.campos || []) v[cp.nome] = cp.tipo === 'data' && nasc ? nasc : CAMPO(cp); x = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: v, p_texto: null }); }
    else if (o.tipo === 'busca_exame' || o.tipo === 'pedido_exames') {
      const ex = await rpc('chat_exames', { p_conversa: p.c, p_token: p.t, p_modalidade: 'RM', p_regiao: 'joelho' });
      x = await rpc('chat_pedido_enviar', { p_conversa: p.c, p_token: p.t, p_itens: [{ modalidade: 'RM', regiao: 'joelho', lado: 'D', procedimento_id: ex[0].id }] });
    } else throw new Error(`tipo não tratado: ${o.tipo}`);
    const ag = ((x && x.respostas) || []).filter((m) => m.autor === 'agente');
    if (!ag.length) throw new Error(`sem resposta depois de ${o.passo}`);
    p.ult = ag.at(-1);
  }
  await como('');
  if (p.ult.opcoes?.tipo !== 'calendario') throw new Error(`não chegou ao calendário (parou em ${p.ult.opcoes?.passo || p.ult.opcoes?.tipo})`);
  return p;
}
const registrarPedido = (p, dados) => comoPaciente(() => rpc('chat_disponibilidade_registrar', { p_conversa: p.c, p_token: p.t, p_dados: dados }));
const base = (extra = {}) => ({ data_ini: dia(1), data_fim: dia(30), dias_semana: [1, 2, 3, 4, 5], turno: 'manha', aceita_notificacao: true, canais: ['chat'], ...extra });


const comoEquipe = async (uid, fn) => { await como(uid); try { return await fn(); } finally { await como(''); } };
const chamar = (uid, nome, args) => comoEquipe(uid, async () => (await q(`select public.${nome}(${args.map((_, i) => '$' + (i + 1)).join(', ')}) r`, args))[0].r);
const mens = async (c) => (await q(`select count(*)::int n from public.mensagens where conversa_id = $1`, [c]))[0].n;
const notas = async (c) => (await q(`select dados -> 'notas' n from public.conversa_fluxo where conversa_id = $1`, [c]))[0]?.n || [];
const FUT = dia(5), PASSADO = dia(-3);
const executor = (op, estado, r = {}) => q(`select public.klingo_operacao_concluir($1, $2, $3::jsonb) r`, [op, estado, JSON.stringify(r)]);
const LISTA = { marcacoes: [
  { id: '9001', procedimento: 'CONSULTA PEDIATRIA', procedimentoId: '1132', unidade: 'DESENVOAR', profissional: 'DRA EXEMPLO', data: FUT, hora: '09:30' },
  { id: '9002', procedimento: 'ULTRASSOM DE ABDOME', procedimentoId: '1472', unidade: 'CSI', profissional: null, data: dia(9), hora: '14:00' },
  { id: '9003', procedimento: 'CONSULTA ANTIGA', procedimentoId: '1132', unidade: 'DESENVOAR', profissional: 'DRA EXEMPLO', data: PASSADO, hora: '08:00' }] };
for (const [k, v] of [['klingo_auto', 'sim'], ['klingo_api_consultar', 'sim'], ['klingo_api_cancelar', 'sim'], ['klingo_api_percentual', '100']]) await cfg(k, v);

const p = await ateOCalendario();
const c = p.c;

await caso('chaves desligadas: o painel avisa "desligado" e não cria operação', async () => {
  await cfg('klingo_api_consultar', 'nao');
  const r = await chamar(ATEND, 'painel_marcacoes_pedir', [c]);
  const n = (await q(`select count(*)::int n from public.klingo_operacao where conversa_id = $1 and tipo = 'ler_vouchers'`, [c]))[0].n;
  await cfg('klingo_api_consultar', 'sim');
  return { ok: r.ok === false && r.motivo === 'desligado' && n === 0, detalhe: JSON.stringify(r) };
});

await caso('conversa sem CPF/nascimento: diz o que falta', async () => {
  const ct = (await um(`insert into public.contatos (nome, telefone) values ('Sem Dados', $1) returning id`, [telefone()])).id;
  const c0 = (await um(`insert into public.conversas (contato_id, nome_informado, status, ia_ativa) values ($1, 'Sem Dados', 'em_atendimento', false) returning id`, [ct])).id;
  const r = await chamar(ATEND, 'painel_marcacoes_pedir', [c0]);
  return { ok: r.ok === false && r.motivo === 'dados_incompletos' && r.faltando.includes('CPF'), detalhe: JSON.stringify(r) };
});

let opLer;
await caso('pedir a lista cria UMA operação da equipe (ler_vouchers) e repetir dentro de 3 min devolve a mesma', async () => {
  const a = await chamar(ATEND, 'painel_marcacoes_pedir', [c]); const b = await chamar(ADMIN, 'painel_marcacoes_pedir', [c]);
  opLer = a.op;
  const o = (await q(`select tipo, origem, detalhe from public.klingo_operacao where id = $1`, [a.op]))[0];
  return { ok: a.ok && b.ok && a.op === b.op && o.tipo === 'ler_vouchers' && o.origem === 'equipe' && o.detalhe.por === 'painel' && o.detalhe.agente === ATEND, detalhe: JSON.stringify([a, b, o]) };
});

await caso('depois da resposta do executor a equipe vê só as marcações FUTURAS e o paciente não recebe mensagem', async () => {
  const antes = await mens(c);
  await executor(opLer, 'sucesso', LISTA);
  const r = await chamar(ATEND, 'painel_marcacoes', [c]);
  const depois = await mens(c);
  const v = r.marcacoes.map((m) => m.voucher).join(',');
  return { ok: v === '9001,9002' && r.consulta.estado === 'sucesso' && antes === depois, detalhe: `${v} msgs ${antes}->${depois}` };
});

await caso('cancelar voucher que não está na lista: "nao_encontrada"; voucher inválido é recusado', async () => {
  const a = await chamar(ATEND, 'painel_marcacao_cancelar', [c, '1234']);
  const e = await erroDe(() => chamar(ATEND, 'painel_marcacao_cancelar', [c, 'abc']));
  const passado = await chamar(ATEND, 'painel_marcacao_cancelar', [c, '9003']);
  return { ok: a.motivo === 'nao_encontrada' && e?.code === '22023' && passado.motivo === 'nao_encontrada', detalhe: JSON.stringify([a, e?.code, passado]) };
});

let opCanc;
await caso('cancelar cria UMA operação "cancelar" da equipe; repetir não duplica', async () => {
  const a = await chamar(ATEND, 'painel_marcacao_cancelar', [c, '9001']); const b = await chamar(ATEND, 'painel_marcacao_cancelar', [c, '9001']);
  opCanc = a.op;
  const o = (await q(`select tipo, origem, detalhe, estado from public.klingo_operacao where id = $1`, [a.op]))[0];
  const st = await chamar(ATEND, 'painel_marcacao_op', [a.op]);
  return { ok: a.ok && b.ok && b.repetido === true && a.op === b.op && o.tipo === 'cancelar' && o.origem === 'equipe' && o.detalhe.voucher === '9001' && o.detalhe.por === 'painel' && st.estado === 'pendente', detalhe: JSON.stringify([a, b, o]) };
});

await caso('Klingo confirma o cancelamento: marcação some da lista, fica a nota para a equipe e o paciente NÃO recebe mensagem nem é transferido', async () => {
  const antes = await mens(c), stAntes = (await q(`select status, agente_id from public.conversas where id = $1`, [c]))[0];
  await executor(opCanc, 'sucesso', {});
  const r = await chamar(ATEND, 'painel_marcacoes', [c]);
  const depois = await mens(c), stDepois = (await q(`select status, agente_id from public.conversas where id = $1`, [c]))[0];
  const nt = (await notas(c)).join(' | ');
  const mc = (await q(`select situacao from public.klingo_marcacao where conversa_id = $1 and voucher = '9001'`, [c]))[0];
  return { ok: r.marcacoes.map((m) => m.voucher).join(',') === '9002' && mc.situacao === 'cancelada' && /9001 cancelada no Klingo pelo painel \(Ana Atendente\)/.test(nt) && antes === depois && stAntes.status === stDepois.status && stAntes.agente_id === stDepois.agente_id, detalhe: `${nt} msgs ${antes}->${depois}` };
});

let opInc;
await caso('falha incerta: nota "conferir ANTES de nova tentativa" e a segunda tentativa é bloqueada até conferir', async () => {
  const a = await chamar(ATEND, 'painel_marcacao_cancelar', [c, '9002']); opInc = a.op;
  await executor(opInc, 'incerto', { codigo: 'timeout' });
  const b = await chamar(ATEND, 'painel_marcacao_cancelar', [c, '9002']);
  const nt = (await notas(c)).join(' | ');
  return { ok: b.ok === false && b.motivo === 'incerto_conferir' && /NÃO concluído \(timeout\).*ANTES de qualquer nova tentativa/.test(nt), detalhe: JSON.stringify(b) + nt };
});

await caso('lista com mais de 10 minutos pede nova consulta antes de cancelar', async () => {
  await q(`update public.klingo_marcacao set consultado_em = now() - interval '15 minutes' where conversa_id = $1 and voucher = '9002'`, [c]);
  await q(`update public.klingo_operacao set estado = 'falha' where id = $1`, [opInc]);
  const r = await chamar(ATEND, 'painel_marcacao_cancelar', [c, '9002']);
  return { ok: r.ok === false && r.motivo === 'lista_antiga', detalhe: JSON.stringify(r) };
});

await caso('chave de cancelar desligada: nada é criado', async () => {
  await q(`update public.klingo_marcacao set consultado_em = now() where conversa_id = $1 and voucher = '9002'`, [c]);
  await cfg('klingo_api_cancelar', 'nao');
  const r = await chamar(ATEND, 'painel_marcacao_cancelar', [c, '9002']);
  await cfg('klingo_api_cancelar', 'sim');
  return { ok: r.ok === false && r.motivo === 'desligado', detalhe: JSON.stringify(r) };
});

await caso('quem não é da equipe (e o anônimo) não vê nem cancela', async () => {
  const e1 = await erroDe(() => chamar(NAOEQUIPE, 'painel_marcacoes', [c]));
  const e2 = await erroDe(() => chamar(NAOEQUIPE, 'painel_marcacao_cancelar', [c, '9002']));
  const e3 = await erroDe(() => chamar(NAOEQUIPE, 'painel_marcacoes_pedir', [c]));
  await anonimo(); const e4 = await erroDe(async () => (await q(`select public.painel_marcacoes($1) r`, [c]))[0].r); await como('');
  return { ok: e1?.code === '42501' && e2?.code === '42501' && e3?.code === '42501' && !!e4, detalhe: JSON.stringify([e1?.code, e2?.code, e3?.code, e4?.message]) };
});

await caso('o caminho do paciente (sem "por = painel") continua intacto na função de cancelamento', async () => {
  const def = (await q(`select pg_get_functiondef('public.klingo_cancelamento_aplicar(uuid,text,text)'::regprocedure) d`))[0].d;
  return { ok: /fluxo_perguntar\(op\.conversa_id, 'marc_pos'/.test(def) && /fluxo_transferir\(op\.conversa_id, 'Paciente pediu para cancelar a marcação/.test(def) && /op\.detalhe ->> 'por' = 'painel'/.test(def), detalhe: '' };
});

await db.close?.();
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
