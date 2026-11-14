// FLUXOGRAMA: entrada (clone da produção de 14/11/2026 + partes 1 a 3 do WebChat v2; pacientes e ofertas inventados) -> validação (paciente de mentira chega ao calendário e registra a disponibilidade pelas funções reais, como anon com token)
//   -> processamento (criar, editar, cancelar, expirar, achar vaga compatível/incompatível, duplicar, notificar com e sem autorização, responder, converter, filhos diferentes, acesso cruzado) -> persistência (só no clone) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Grupo C do prompt mestre: a solicitação futura NÃO cria agendamento, a notificação NÃO afirma agendamento e nada é "enviado" sem canal autorizado e sem a chave ligada.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste'), ('klingo_interno_segredo', 'interno-de-teste')`);
let sqlErro = null;
for (const f of ['webchat-v2-parte1-modos', 'webchat-v2-parte2-calendario-api', 'webchat-v2-parte3-disponibilidade-futura']) {
  try { await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8')); } catch (e) { sqlErro = `${f}: ${String(e.message).split('\n')[0]}`; }
}
registrar('o retrato da produção monta inteiro e as partes 1 a 3 do WebChat v2 aplicam sem erro', falhas.length === 0 && !sqlErro, sqlErro ?? '');

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
const TESTE = '71988880077';
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
const estadoDe = async (id) => (await um(`select estado from public.disponibilidade_pedido where id = $1`, [id])).estado;
const oferta = (d, h, un = UNIDADE, prof = 'DRA EXEMPLO IMAGEM') => ({ chave: `${d}|63|308|2|${h}`, data: d, hora: h, unidade: un, profissional: prof });
// próxima data (a partir de n dias) que cai em dia útil
const util = (n) => { let i = n; while ([0, 6].includes(dow(dia(i)))) i++; return dia(i); };

await cfg('klingo_auto', 'sim'); await cfg('klingo_api_telefones_teste', TESTE); await cfg('klingo_api_percentual', '100'); await cfg('previsao_modo', 'teste'); await cfg('previsao_monitor_modo', 'teste'); await cfg('notificacao_modo', 'nao');
let A, sol;

// ------------------------------------------------------------------ criar
await caso('CRIAR: solicitação fica "ativa", NÃO cria agendamento nem operação no Klingo, avisa que NÃO é agendamento e o fluxo segue (não fica preso)', async () => {
  A = await ateOCalendario(); await ativar(A);
  const r = await registrarPedido(A, base());
  sol = r.solicitacao;
  const pa = await um(`select status from public.pre_agendamentos where conversa_id = $1`, [A.c]);
  const ops = (await um(`select count(*)::int n from public.klingo_operacao`)).n;
  const msgs = await q(`select texto, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 3`, [A.c]);
  const aviso = msgs.find((m) => m.opcoes?.tipo === 'disponibilidade_registrada');
  const seguiu = msgs.some((m) => m.opcoes && m.opcoes.tipo !== 'disponibilidade_registrada');
  return { ok: r.ok && sol.estado === 'ativa' && pa.status !== 'agendado' && ops === 0 && /NÃO é um agendamento/.test(aviso?.texto ?? '') && seguiu, detalhe: `estado=${sol.estado}; pedido=${pa.status}; operações=${ops}; fluxo seguiu=${seguiu}` };
});
await caso('CRIAR sem autorização de recurso: paciente comum (modo "teste", fora da lista) é recusado com mensagem de equipe (P0001)', async () => {
  const comum = await ateOCalendario();
  const e = await erroDe(() => registrarPedido(comum, base()));
  return { ok: e && e.code === 'P0001' && /equipe/.test(e.msg), detalhe: JSON.stringify(e) };
});
await caso('VALIDAÇÃO: data final antes da inicial, período > 1 ano, turno e horário inválidos são recusados; dias vazios = todos', async () => {
  const p = await ateOCalendario(); await ativar(p);
  const casos = [base({ data_ini: dia(10), data_fim: dia(5) }), base({ data_fim: dia(400) }), base({ turno: 'madrugada' }), base({ hora_ini: '10:00', hora_fim: '09:00' }), base({ hora_ini: '9h' })];
  const erros = []; for (const c of casos) erros.push((await erroDe(() => registrarPedido(p, c)))?.code ?? 'aceitou');
  const ok1 = (await registrarPedido(p, base({ dias_semana: [] }))).solicitacao;
  return { ok: erros.every((c) => c === '22023' || c === '23514') && ok1.dias_semana.length === 7, detalhe: `recusas=${erros.join(',')}; dias vazios -> ${ok1.dias_semana.length} dias` };
});
await caso('IDEMPOTÊNCIA: registrar de novo a mesma solicitação (duplo clique, outra conversa da mesma pessoa) atualiza a MESMA, sem duplicar', async () => {
  await registrarPedido(A, base({ turno: 'tarde' })); await registrarPedido(A, base({ turno: 'tarde' }));
  const n = (await um(`select count(*)::int n from public.disponibilidade_pedido where conversa_id = $1 and estado = 'ativa'`, [A.c])).n;
  const eventos = (await um(`select count(*) filter (where tipo = 'criada')::int c, count(*) filter (where tipo = 'editada')::int e from public.disponibilidade_evento where pedido_id = $1`, [sol.id]));
  return { ok: n === 1 && eventos.c === 1 && eventos.e >= 2, detalhe: `abertas=${n}; criada=${eventos.c}; editada=${eventos.e}` };
});
await caso('EDITAR e CONSULTAR: o paciente altera preferências e vê a solicitação; sem dado pessoal no retorno', async () => {
  const e = await comoPaciente(() => rpc('chat_disponibilidade_alterar', { p_conversa: A.c, p_token: A.t, p_id: sol.id, p_dados: base({ turno: 'manha', dias_semana: [2, 4] }) }));
  const v = await comoPaciente(() => rpc('chat_disponibilidade_ver', { p_conversa: A.c, p_token: A.t }));
  const txt = JSON.stringify(v);
  return { ok: e.ok && v.solicitacoes.length === 1 && v.solicitacoes[0].turno === 'manha' && JSON.stringify(v.solicitacoes[0].dias_semana) === '[2,4]' && !/111\.?444|Maria|1980|71988880077/.test(txt), detalhe: `turno=${v.solicitacoes[0].turno}; dias=${JSON.stringify(v.solicitacoes[0].dias_semana)}` };
});

// ------------------------------------------------------------------ achar vaga
await cfg('klingo_api_horarios', 'teste');
await caso('VAGA COMPATÍVEL: oferta real que cruza com dia da semana, turno e período vira oportunidade (estado "oportunidade_identificada") e a notificação fica PENDENTE (nada foi enviado)', async () => {
  let d = util(3); while (![2, 4].includes(dow(d))) d = dia(Math.round((Date.parse(d) - Date.parse(dia(0))) / 864e5) + 1);
  const r = await um(`select public.disponibilidade_oportunidades_gravar($1, $2::jsonb) r`, [sol.id, JSON.stringify([oferta(d, '14:00'), oferta(d, '09:00')])]);   // 14:00 é tarde (incompatível); 09:00 serve
  const o = await q(`select hora, estado from public.disponibilidade_oportunidade where pedido_id = $1`, [sol.id]);
  const n = await q(`select estado from public.disponibilidade_notificacao where pedido_id = $1`, [sol.id]);
  return { ok: r.r.novas === 1 && r.r.compativeis === 1 && o.length === 1 && o[0].hora === '09:00' && n[0].estado === 'pendente' && (await estadoDe(sol.id)) === 'oportunidade_identificada', detalhe: `compatíveis=${r.r.compativeis}; oportunidades=${JSON.stringify(o)}; notificação=${n[0]?.estado}` };
});
await caso('NÃO ENVIA sem a chave: com notificacao_modo "nao" nada é entregue (nenhuma mensagem de aviso é simulada) e a fila continua visível', async () => {
  const antes = (await um(`select count(*)::int n from public.mensagens where conversa_id = $1`, [A.c])).n;
  const ent = (await um(`select public.disponibilidade_entregar_pendentes() n`)).n;
  const depois = (await um(`select count(*)::int n from public.mensagens where conversa_id = $1`, [A.c])).n;
  const n = await q(`select estado from public.disponibilidade_notificacao where pedido_id = $1`, [sol.id]);
  return { ok: ent === 0 && antes === depois && n[0].estado === 'pendente', detalhe: `entregues=${ent}; mensagens ${antes}->${depois}; notificação=${n[0].estado}` };
});
await caso('NOTIFICA com a chave ligada e canal autorizado: mensagem no chat SEM afirmar agendamento; estado "notificada"; entrega registrada', async () => {
  await cfg('notificacao_modo', 'teste');
  const ent = (await um(`select public.disponibilidade_entregar_pendentes() n`)).n;
  const m = await um(`select texto, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' and opcoes ->> 'tipo' = 'disponibilidade_oportunidade' order by id desc limit 1`, [A.c]);
  const n = await um(`select estado, entregue_em from public.disponibilidade_notificacao where pedido_id = $1`, [sol.id]);
  const semPromessa = !/foi agendado|está agendado|agendamos|marcamos|confirmad[oa]|reservamos/i.test(m.texto) && /NÃO está reservado/.test(m.texto) && /Consulte a disponibilidade atual/.test(m.texto);
  return { ok: ent === 1 && semPromessa && n.estado === 'entregue_ao_chat' && n.entregue_em && (await estadoDe(sol.id)) === 'notificada', detalhe: `texto: ${m.texto.slice(0, 120)}...` };
});
await caso('NOTIFICAÇÃO DUPLICADA: a mesma vaga nunca gera um segundo aviso para a mesma solicitação, mesmo achada de novo', async () => {
  const antes = (await um(`select count(*)::int n from public.disponibilidade_notificacao where pedido_id = $1`, [sol.id])).n;
  await um(`select public.disponibilidade_oportunidades_gravar($1, $2::jsonb) r`, [sol.id, JSON.stringify([oferta(util(3), '09:00')])]);   // solicitação já não está "ativa": recusada
  const depois = (await um(`select count(*)::int n from public.disponibilidade_notificacao where pedido_id = $1`, [sol.id])).n;
  return { ok: antes === 1 && depois === 1, detalhe: `${antes} -> ${depois}` };
});
await caso('OPORTUNIDADE VENCIDA / paciente responde depois que o horário foi ocupado: nada é reservado, a solicitação volta a "ativa" e o paciente é avisado', async () => {
  await db.query(`update public.disponibilidade_oportunidade set valida_ate = now() - interval '1 minute' where pedido_id = $1`, [sol.id]);
  const r = await comoPaciente(() => rpc('chat_disponibilidade_responder', { p_conversa: A.c, p_token: A.t, p_id: sol.id, p_aceita: true }));
  const pa = await um(`select status, escolha_horario from public.pre_agendamentos where conversa_id = $1`, [A.c]);
  return { ok: r.ok === false && r.motivo === 'oportunidade_expirada' && (await estadoDe(sol.id)) === 'ativa' && pa.status !== 'agendado' && !pa.escolha_horario, detalhe: `${r.motivo}; estado=${await estadoDe(sol.id)}` };
});
await caso('VAGA INCOMPATÍVEL: fim de semana, fora do período, turno errado e outra unidade (quando não aceita outras) NÃO viram oportunidade', async () => {
  await comoPaciente(() => rpc('chat_disponibilidade_alterar', { p_conversa: A.c, p_token: A.t, p_id: sol.id, p_dados: base({ turno: 'manha', dias_semana: [1, 2, 3, 4, 5], aceita_outras_unidades: false, unidade: UNIDADE }) }));
  let sab = dia(3); while (dow(sab) !== 6) sab = dia(Math.round((Date.parse(sab) - Date.parse(dia(0))) / 864e5) + 1);
  const uteis = util(2);
  const r = await um(`select public.disponibilidade_oportunidades_gravar($1, $2::jsonb) r`, [sol.id, JSON.stringify([oferta(sab, '09:00'), oferta(dia(90), '09:00'), oferta(uteis, '15:00'), oferta(uteis, '09:00', 'OUTRA UNIDADE'), oferta(dia(-1), '09:00')])]);
  const n = (await um(`select count(*)::int n from public.disponibilidade_oportunidade where pedido_id = $1 and oferta_chave like '%|09:00'`, [sol.id])).n;
  return { ok: r.r.compativeis === 0 && r.r.novas === 0 && n === 1 && (await estadoDe(sol.id)) === 'ativa', detalhe: `compatíveis=${r.r.compativeis}; novas=${r.r.novas}` };
});
await caso('NOVA ABERTURA DE AGENDA / convênio volta: uma oferta nova e compatível depois gera NOVA oportunidade; aceitar volta ao calendário normal (consulta nova), sem reservar nada', async () => {
  await cfg('previsao_monitor_modo', 'teste');
  const d = util(4);
  await um(`select public.disponibilidade_oportunidades_gravar($1, $2::jsonb) r`, [sol.id, JSON.stringify([oferta(d, '10:00')])]);
  await um(`select public.disponibilidade_entregar_pendentes()`);
  const r = await comoPaciente(() => rpc('chat_disponibilidade_responder', { p_conversa: A.c, p_token: A.t, p_id: sol.id, p_aceita: true }));
  const pa = await um(`select status, escolha_horario from public.pre_agendamentos where conversa_id = $1`, [A.c]);
  const f = await um(`select passo from public.conversa_fluxo where conversa_id = $1`, [A.c]);
  const ops = (await um(`select count(*)::int n from public.klingo_operacao`)).n;
  return { ok: r.ok && r.acao === 'abrir_calendario' && (await estadoDe(sol.id)) === 'aguardando_resposta' && pa.status === 'rascunho' && !pa.escolha_horario && ops === 0, detalhe: `acao=${r.acao}; estado=${await estadoDe(sol.id)}; pedido=${pa.status}; passo=${f.passo}; operações=${ops}` };
});
await caso('CONVERSÃO: agendamento confirmado fecha a solicitação ("convertida_em_agendamento") com o pedido associado; estado final não aceita mais mudança nem oferta', async () => {
  await db.query(`update public.pre_agendamentos set status = 'agendado', agendado_origem = 'chat_api' where conversa_id = $1`, [A.c]);
  const p = await um(`select estado, agendamento_pre_id, convertida_em from public.disponibilidade_pedido where id = $1`, [sol.id]);
  const e = await erroDe(() => db.query(`update public.disponibilidade_pedido set estado = 'ativa' where id = $1`, [sol.id]));
  const r = await um(`select public.disponibilidade_oportunidades_gravar($1, $2::jsonb) r`, [sol.id, JSON.stringify([oferta(util(5), '09:00')])]);
  return { ok: p.estado === 'convertida_em_agendamento' && p.agendamento_pre_id && p.convertida_em && e && e.code === '23514' && r.r.ok === false, detalhe: `estado=${p.estado}; transição inválida=${e?.code}; nova oferta=${r.r.motivo}` };
});

// ------------------------------------------------------------------ cancelar / expirar / autorização
await caso('CANCELAR: o paciente cancela; solicitação cancelada não recebe mais oferta; cancelar de novo é inofensivo', async () => {
  const B = await ateOCalendario(); await ativar(B);
  const s = (await registrarPedido(B, base())).solicitacao;
  const c1 = await comoPaciente(() => rpc('chat_disponibilidade_cancelar', { p_conversa: B.c, p_token: B.t, p_id: s.id }));
  const c2 = await comoPaciente(() => rpc('chat_disponibilidade_cancelar', { p_conversa: B.c, p_token: B.t, p_id: s.id }));
  const r = await um(`select public.disponibilidade_oportunidades_gravar($1, $2::jsonb) r`, [s.id, JSON.stringify([oferta(util(3), '09:00')])]);
  return { ok: c1.estado === 'cancelada' && c2.ja_terminada === true && r.r.ok === false && (await estadoDe(s.id)) === 'cancelada', detalhe: `${c1.estado}; reenvio=${c2.ja_terminada}; oferta=${r.r.motivo}` };
});
await caso('EXPIRAR: passou do período => "expirada" pela rotina; expirada não recebe oferta e some da busca', async () => {
  const B = await ateOCalendario(); await ativar(B);
  const s = (await registrarPedido(B, base())).solicitacao;
  await db.query(`update public.disponibilidade_pedido set expira_em = now() - interval '1 hour' where id = $1`, [s.id]);
  const v = await um(`select public.previsao_vigiar() r`);
  const alvos = (await um(`select public.disponibilidade_alvos(50) r`)).r.map((x) => x.pedido_id);
  const r = await um(`select public.disponibilidade_oportunidades_gravar($1, $2::jsonb) r`, [s.id, JSON.stringify([oferta(util(3), '09:00')])]);
  return { ok: (await estadoDe(s.id)) === 'expirada' && v.r.expiradas >= 1 && !alvos.includes(s.id) && r.r.ok === false, detalhe: `estado=${await estadoDe(s.id)}; rotina=${JSON.stringify(v.r)}` };
});
await caso('SEM AUTORIZAÇÃO para notificar: a oportunidade é registrada, a notificação fica "bloqueada_sem_autorizacao", NADA é enviado e a equipe vê "precisa de humano"', async () => {
  const B = await ateOCalendario(); await ativar(B); await cfg('notificacao_modo', 'sim');
  const s = (await registrarPedido(B, base({ aceita_notificacao: false, canais: ['chat'] }))).solicitacao;
  await um(`select public.disponibilidade_oportunidades_gravar($1, $2::jsonb) r`, [s.id, JSON.stringify([oferta(util(3), '09:00')])]);
  const ent = (await um(`select public.disponibilidade_entregar_pendentes() n`)).n;
  const n = await um(`select estado from public.disponibilidade_notificacao where pedido_id = $1`, [s.id]);
  const msg = (await um(`select count(*)::int n from public.mensagens where conversa_id = $1 and opcoes ->> 'tipo' = 'disponibilidade_oportunidade'`, [B.c])).n;
  await como(ATEND); const l = await um(`select public.painel_disponibilidade_lista() r`); await como('');
  const item = l.r.itens.find((i) => i.id === s.id);
  await cfg('notificacao_modo', 'teste');
  return { ok: s.canais.length === 0 && n.estado === 'bloqueada_sem_autorizacao' && ent === 0 && msg === 0 && item?.precisa_humano === true, detalhe: `canais=${JSON.stringify(s.canais)}; notificação=${n.estado}; mensagens de aviso=${msg}; precisa_humano=${item?.precisa_humano}` };
});
await caso('LIMITE de avisos por dia: a 2ª vaga no mesmo dia é registrada mas NÃO notificada ("bloqueada_limite")', async () => {
  const B = await ateOCalendario(); await ativar(B); await cfg('disponibilidade_max_avisos_dia', '1');
  const s = (await registrarPedido(B, base())).solicitacao;
  await um(`select public.disponibilidade_oportunidades_gravar($1, $2::jsonb) r`, [s.id, JSON.stringify([oferta(util(3), '09:00')])]);
  await um(`select public.disponibilidade_entregar_pendentes()`);
  await db.query(`update public.disponibilidade_oportunidade set valida_ate = now() - interval '1 minute' where pedido_id = $1`, [s.id]);
  await um(`select public.disponibilidade_vigiar()`);
  await um(`select public.disponibilidade_oportunidades_gravar($1, $2::jsonb) r`, [s.id, JSON.stringify([oferta(util(5), '09:30')])]);
  const n = await q(`select estado from public.disponibilidade_notificacao where pedido_id = $1 order by criado_em, id`, [s.id]);
  await cfg('disponibilidade_max_avisos_dia', '2');
  return { ok: n.length === 2 && n[0].estado === 'entregue_ao_chat' && n[1].estado === 'bloqueada_limite', detalhe: n.map((x) => x.estado).join(' > ') };
});

// ------------------------------------------------------------------ filhos, responsável, acesso cruzado
await caso('RESPONSÁVEL COM DOIS FILHOS (mesmo telefone/CPF do responsável, nascimentos diferentes): duas solicitações separadas; um não vê nem cancela a do outro', async () => {
  const F1 = await ateOCalendario('10/05/2018'); await ativar(F1);
  const F2 = await ateOCalendario('22/09/2020'); await ativar(F2);
  const s1 = (await registrarPedido(F1, base())).solicitacao, s2 = (await registrarPedido(F2, base())).solicitacao;
  const k = await q(`select distinct pessoa_chave from public.disponibilidade_pedido where id in ($1, $2)`, [s1.id, s2.id]);
  const v1 = await comoPaciente(() => rpc('chat_disponibilidade_ver', { p_conversa: F1.c, p_token: F1.t }));
  const e = await erroDe(() => comoPaciente(() => rpc('chat_disponibilidade_cancelar', { p_conversa: F1.c, p_token: F1.t, p_id: s2.id })));
  return { ok: s1.id !== s2.id && k.length === 2 && v1.solicitacoes.length === 1 && v1.solicitacoes[0].id === s1.id && e && e.code === 'P0002' && (await estadoDe(s2.id)) === 'ativa', detalhe: `pessoas=${k.length}; F1 vê ${v1.solicitacoes.length}; cancelar a do outro=${e?.code}` };
});
await caso('SEGURANÇA: token errado, token de outra conversa e leitura direta das tabelas são recusados para o paciente; atendente lê pelo painel; quem não é da equipe não', async () => {
  const e1 = await erroDe(() => comoPaciente(() => rpc('chat_disponibilidade_ver', { p_conversa: A.c, p_token: 'token-errado' })));
  const outra = await ateOCalendario();
  const e2 = await erroDe(() => comoPaciente(() => rpc('chat_disponibilidade_ver', { p_conversa: A.c, p_token: outra.t })));
  await anonimo(); const diretas = []; for (const t of ['disponibilidade_pedido', 'disponibilidade_evento', 'disponibilidade_oportunidade', 'disponibilidade_notificacao']) diretas.push((await erroDe(() => q(`select * from public.${t} limit 1`)))?.code ?? 'LEU'); await como('');
  await como(NAOEQUIPE); const e3 = await erroDe(() => q(`select public.painel_disponibilidade_lista() r`)); await como('');
  await como(ATEND); const l = await um(`select public.painel_disponibilidade_lista() r`); await como('');
  return { ok: e1?.code === '28000' && e2?.code === '28000' && diretas.every((c) => c === '42501') && e3?.code === '42501' && l.r.itens.length >= 3 && Object.keys(l.r.contagem).length >= 3, detalhe: `token errado=${e1?.code}; token alheio=${e2?.code}; leitura direta=${diretas.join(',')}; não-equipe=${e3?.code}; itens no painel=${l.r.itens.length}` };
});

// ------------------------------------------------------------------ motor
await caso('MOTOR: em "nao" não busca nada; em "sombra" busca e só conta (nenhuma oportunidade); em "teste" só a lista; o alvo some por 9 min depois de verificado', async () => {
  const B = await ateOCalendario(); await ativar(B);
  const s = (await registrarPedido(B, base({ turno: 'qualquer', dias_semana: [0, 1, 2, 3, 4, 5, 6] }))).solicitacao;
  const alvos = async () => (await um(`select public.disponibilidade_alvos(50) r`)).r.filter((x) => x.pedido_id === s.id);
  await cfg('previsao_monitor_modo', 'nao'); const off = (await alvos()).length;
  await cfg('previsao_monitor_modo', 'sombra'); const sombra = await alvos();
  const rs = await um(`select public.disponibilidade_oportunidades_gravar($1, $2::jsonb, true) r`, [s.id, JSON.stringify([oferta(util(3), '09:00')])]);
  const opp = (await um(`select count(*)::int n from public.disponibilidade_oportunidade where pedido_id = $1`, [s.id])).n;
  await cfg('previsao_monitor_modo', 'teste'); await um(`select public.disponibilidade_verificada($1, 'ok_com_horarios') `, [s.id]); const recente = (await alvos()).length;
  return { ok: off === 0 && sombra.length === 1 && sombra[0].modo === 'sombra' && rs.r.compativeis === 1 && rs.r.novas === 0 && opp === 0 && recente === 0, detalhe: `nao=${off}; sombra=${sombra.length}/${sombra[0]?.modo}; compatíveis em sombra=${rs.r.compativeis}; oportunidades gravadas=${opp}; logo após verificar=${recente}` };
});
await caso('A previsão antiga (grade) acabou: previsao_ativa = false, previsao_vigiar é o motor novo e a lista antiga não tem linhas', async () => {
  const a = await um(`select public.previsao_ativa($1) a`, [A.c]); const v = await um(`select public.previsao_vigiar() r`);
  const velho = (await um(`select count(*)::int n from public.pedido_previsao`)).n;
  return { ok: a.a === false && 'expiradas' in v.r && 'alvos' in v.r && velho === 0, detalhe: `previsao_ativa=${a.a}; vigiar=${JSON.stringify(v.r)}; linhas antigas=${velho}` };
});
await caso('POLÍTICA DE ENCERRAMENTO é configurável e vem DESLIGADA: por padrão a conversa não é encerrada; ligada, encerra só sem humano nem operação pendente', async () => {
  const B = await ateOCalendario(); await ativar(B);
  await registrarPedido(B, base()); const padrao = (await um(`select status from public.conversas where id = $1`, [B.c])).status;
  const C = await ateOCalendario(); await ativar(C); await cfg('disponibilidade_encerra_conversa', 'sim');
  await registrarPedido(C, base()); const ligado = await um(`select status, motivo_encerramento, encerramento_origem from public.conversas where id = $1`, [C.c]);
  await cfg('disponibilidade_encerra_conversa', 'nao');
  return { ok: padrao !== 'encerrada' && ligado.status === 'encerrada' && ligado.encerramento_origem === 'sistema', detalhe: `padrão=${padrao}; ligado=${ligado.status}/${ligado.motivo_encerramento}/${ligado.encerramento_origem}` };
});

console.log(`\n${resultados.filter(Boolean).length} de ${resultados.length} verificações passaram.`);
process.exit(resultados.every(Boolean) ? 0 : 1);
