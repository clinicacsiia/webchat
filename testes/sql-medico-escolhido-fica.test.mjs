// FLUXOGRAMA: entrada (clone da produção + webchat-v2-parte1..2 + supabase/medico-escolhido-fica-parte1..5.sql; ofertas da API inventadas com 2 médicos) -> validação (paciente de mentira chega ao calendário e escolhe um médico)
//   -> processamento (chat_horarios só do médico escolhido, sem cair para os outros; chat_horario_escolher e klingo_pode_marcar recusam horário de outro médico; chat_medico_sem_horario_abrir abre a previsão só com ele)
//   -> persistência (só no clone) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 17/11/2026 / Mudança: primeira versão (caso real: a paciente pediu uma médica, a médica não tinha horário nos 15 primeiros dias e o chat marcou com outra).
// Dados: nenhum dado real; nomes de médico inventados.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
let sqlErro = null;
for (const f of ['webchat-v2-parte1-modos', 'webchat-v2-parte2-calendario-api', 'medico-escolhido-fica-parte1', 'medico-escolhido-fica-parte2', 'medico-escolhido-fica-parte3', 'medico-escolhido-fica-parte4', 'medico-escolhido-fica-parte4b', 'medico-escolhido-fica-parte5', 'medico-escolhido-fica-parte6', 'medico-escolhido-fica-parte6b']) {
  try { await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8')); } catch (e) { sqlErro = `${f}: ${String(e.message).split('\n')[0]}`; }
}
registrar('o retrato da produção monta inteiro e as migrações do WebChat v2 e do médico escolhido aplicam sem erro', falhas.length === 0 && !sqlErro, sqlErro ?? '');

const UNIDADE = 'CLÍNICA DE SAÚDE E IMAGEM - CSI';
await db.exec(`
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!'), ('reabrir_dias', '2')
    on conflict (chave) do update set valor = excluded.valor;
  insert into public.catalogo_regiao (codigo, nome, padrao, tem_lado, grupo, ordem) values ('joelho', 'Joelho', 'JOELHO', true, 'perna', 1), ('abdome', 'Abdome', 'ABDOME', false, 'tronco', 2);
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values
    (201, 'RESSONANCIA MAGNETICA DO JOELHO (UNILATERAL)', 'RESSONANCIA MAGNETICA', true, 9, ''), (202, 'ULTRASSONOGRAFIA DE ABDOME TOTAL', 'ULTRASSONOGRAFIA', true, 7, ''), (301, 'CONSULTA', 'CONSULTAS', true, 20, '');
  -- A GRADE tem horário todos os dias, das 08:00 às 12:00, de 30 em 30: se ela vazar para o calendário, o teste vê.
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select p.id, p.nome, '${UNIDADE}', case when p.id = 201 then 'RESSONANCIA' when p.id = 202 then 'ULTRASSOM 1' else 'CONSULTORIO 1' end, 'DRA EXEMPLO IMAGEM',
           case when p.id = 301 then 'CARDIOLOGIA' else 'RADIOLOGIA' end, d, '08:00', '12:00', 30, current_date - 30, current_date + 300
    from public.catalogo_procedimento p cross join generate_series(0, 6) d;
`);
const cfg = (chave, valor) => db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]);
const dia = (n) => new Date(Date.now() + n * 864e5).toLocaleString('sv-SE', { timeZone: 'America/Bahia' }).slice(0, 10);

const CAMPO = (c) => (c.tipo === 'sexo' ? 'F' : c.tipo === 'data' ? '25/03/1980' : c.tipo === 'cpf' ? '111.444.777-35' : c.tipo === 'tel' ? '(71) 99999-0001' : c.tipo === 'email' ? 'maria@exemplo.invalid'
  : c.tipo === 'cep' ? '40000-000' : c.tipo === 'uf' ? 'BA' : c.nome === 'nome' ? 'Maria Teste da Silva' : c.nome === 'mae' ? 'Ana Teste da Silva' : c.nome === 'numero' ? '10' : 'Texto de teste');
let nTel = 0;
const telefone = () => '7198' + String(6000000 + ++nTel);
const rpc = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  const r = await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k])));
  return r[0].r;
};
// Leva um paciente de mentira até a pergunta do calendário (exame: RM de joelho).
async function ateOCalendario(tel = telefone()) {
  await anonimo();
  const r = await rpc('chat_iniciar', { p_nome: 'Maria Teste da Silva', p_telefone: tel, p_email: 'maria@exemplo.invalid', p_aceite: true, p_paciente_tipo: 'proprio' });
  const p = { c: r.conversa_id, t: r.token, tel, ult: r.respostas.at(-1) };
  for (let i = 0; i < 30; i++) {
    const o = p.ult.opcoes;
    if (!o || o.tipo === 'calendario' || o.tipo === 'acompanhar') break;
    await anonimo();
    let x;
    if (o.tipo === 'escolha') { const it = (o.itens || [])[0]; x = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify(it.valor), p_texto: it.rotulo }); }
    else if (o.tipo === 'campos') { const v = {}; for (const cp of o.campos || []) v[cp.nome] = CAMPO(cp); x = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: v, p_texto: null }); }
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
const horarios = async (p, extra = {}) => { await anonimo(); try { return await rpc('chat_horarios', { p_conversa: p.c, p_token: p.t, p_grupo: 1, p_de: dia(0), p_ate: dia(40), ...extra }); } finally { await como(''); } };
const escolher = async (p, data, hora, unidade = null) => { await anonimo(); try { return await rpc('chat_horario_escolher', { p_conversa: p.c, p_token: p.t, p_grupo: 1, p_data: data, p_hora: hora, p_unidade: unidade }); } finally { await como(''); } };
const erroDe = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, msg: String(e.message).split('\n')[0] }; } };
const TESTE = '71900000001';
const ofertar = async (c, itens, sombra = false) => {
  const l = itens.map(([d, h, prof, un]) => ({ chave: `${d}|63|308|2|${h}`, data: d, hora: h, profissional: prof ?? 'DRA EXEMPLO IMAGEM', unidade: un ?? UNIDADE }));
  return (await um(`select public.klingo_oferta_gravar_v2($1, 201, 1, $2::jsonb, $3, true) n`, [c, JSON.stringify(l), sombra])).n;
};
const consulta = (c, resultado, modo = 'teste') => db.query(`select public.klingo_consulta_registrar($1, $2, 'exame', 201, 1, $3, 200, 5, 5, 0, 2, 900, null)`, [c, modo, resultado]);
// põe o telefone do paciente de mentira na lista de teste (o telefone da lista é único por contato)
const ativar = (p) => cfg('klingo_api_telefones_teste', `${TESTE},${p.tel}`);
const slots = (r) => (r.dias || []).flatMap((d) => d.slots.map((s) => `${d.data} ${s.hora}`));


await cfg('klingo_auto', 'sim'); await cfg('klingo_api_telefones_teste', TESTE); await cfg('klingo_api_percentual', '100'); await cfg('klingo_api_horarios', 'teste'); await cfg('klingo_api_marcar', 'teste'); await cfg('previsao_modo', 'sim');
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste') on conflict (name) do nothing`);
const DRA_A = 'MAIANA DE TESTE SILVA', DRA_B = 'MARIA CELESTE DE TESTE';
const escolheMedico = (c, nome) => db.query(`update public.conversas set medico_preferido = $2 where id = $1`, [c, nome]);

// ---------------------------------------------------------------------------------------------- A. a lista só tem o médico escolhido
let p;
await caso('só há horários de OUTRO médico: o médico escolhido não é trocado (lista vazia, medico_sem_horario = true, medico_filtrando = true)', async () => {
  p = await ateOCalendario(TESTE); await escolheMedico(p.c, DRA_A);
  await ofertar(p.c, [[dia(3), '08:30', DRA_B], [dia(3), '10:00', DRA_B], [dia(5), '11:30', DRA_B]]); await consulta(p.c, 'ok_com_horarios');
  const r = await horarios(p);
  return { ok: slots(r).length === 0 && r.medico_sem_horario === true && r.medico_filtrando === true && r.estado === 'com_horarios', detalhe: `slots=${slots(r).length}; sem_horario=${r.medico_sem_horario}; filtrando=${r.medico_filtrando}` };
});
await caso('chegando horário do médico escolhido: só os dele(a) aparecem (os do outro médico continuam escondidos)', async () => {
  await ofertar(p.c, [[dia(3), '08:30', DRA_B], [dia(3), '10:00', DRA_B], [dia(5), '11:30', DRA_B], [dia(20), '09:20', DRA_A]]);
  const r = await horarios(p);
  return { ok: JSON.stringify(slots(r)) === JSON.stringify([`${dia(20)} 09:20`]) && r.medico_sem_horario === false && r.medico_filtrando === true, detalhe: JSON.stringify(slots(r)) };
});
await caso('sem médico escolhido ("tanto faz"): continuam todos os horários, sem aviso', async () => {
  await escolheMedico(p.c, null);
  const r = await horarios(p);
  return { ok: slots(r).length === 4 && r.medico_sem_horario === false && r.medico_filtrando === false, detalhe: `slots=${slots(r).length}` };
});

// ---------------------------------------------------------------------------------------------- B. trava no servidor
await caso('chat_horario_escolher RECUSA o horário de outro médico, mesmo pedido direto (o chat nunca grava a troca)', async () => {
  await escolheMedico(p.c, DRA_A);
  const e = await erroDe(() => escolher(p, dia(3), '10:00'));
  const pa = await um(`select escolha_horario from public.pre_agendamentos where conversa_id = $1`, [p.c]);
  return { ok: e && /não é do\(a\) médico\(a\) que você escolheu/.test(e.msg) && !(pa.escolha_horario || []).length, detalhe: JSON.stringify(e) };
});
await caso('chat_horario_escolher ACEITA o horário do médico escolhido', async () => {
  const r = await escolher(p, dia(20), '09:20');
  const pa = await um(`select escolha_horario from public.pre_agendamentos where conversa_id = $1`, [p.c]);
  return { ok: r.ok === true && pa.escolha_horario[0].profissional === DRA_A, detalhe: JSON.stringify(pa.escolha_horario) };
});
await caso('klingo_pode_marcar não marca sozinho com médico diferente do escolhido (motivo medico_diferente) e marca (passa dessa trava) com o mesmo médico', async () => {
  // força uma escolha com o horário do outro médico, como se tivesse escapado
  const chaveB = (await um(`select chave from public.klingo_oferta where conversa_id = $1 and profissional = $2 limit 1`, [p.c, DRA_B])).chave;
  const antes = (await um(`select escolha_horario from public.pre_agendamentos where conversa_id = $1`, [p.c])).escolha_horario;
  await db.query(`update public.pre_agendamentos set escolha_horario = jsonb_build_array(jsonb_build_object('grupo', 1, 'data', $2::text, 'hora', '08:30', 'unidade', $3::text, 'profissional', $4::text, 'origem', 'klingo_api', 'klingo_chave', $5::text)) where conversa_id = $1`, [p.c, dia(3), UNIDADE, DRA_B, chaveB]);
  const r1 = (await um(`select public.klingo_pode_marcar($1) r`, [p.c])).r;
  await db.query(`update public.pre_agendamentos set escolha_horario = $2::jsonb where conversa_id = $1`, [p.c, JSON.stringify(antes)]);
  const r2 = (await um(`select public.klingo_pode_marcar($1) r`, [p.c])).r;
  return { ok: r1.ok === false && r1.motivo === 'medico_diferente' && r2.motivo !== 'medico_diferente', detalhe: `outro médico: ${JSON.stringify(r1)}; mesmo médico: ${r2.motivo ?? 'ok'}` };
});

// ---------------------------------------------------------------------------------------------- C. previsão só com o médico escolhido
let q2;
await caso('médico sem horário: chat_medico_sem_horario_abrir abre a solicitação SÓ com ele(a) (profissional fixo mesmo que o chat peça outro), com os dias, o turno e o prazo que o paciente digitou, e avisa o paciente', async () => {
  q2 = await ateOCalendario(telefone()); await ativar(q2); await escolheMedico(q2.c, DRA_A);
  await ofertar(q2.c, [[dia(3), '08:30', DRA_B]]); await consulta(q2.c, 'ok_com_horarios');
  await anonimo();
  const r = await rpc('chat_medico_sem_horario_abrir', { p_conversa: q2.c, p_token: q2.t, p_dados: { data_ini: dia(1), data_fim: dia(30), dias_semana: [1, 3], turno: 'manha', aceita_outros_profissionais: true, profissional: DRA_B } }); await como('');
  const d = await um(`select profissional_preferido, aceita_outros_profissionais, aceita_notificacao, estado, turno, dias_semana, data_ini::text di, data_fim::text df from public.disponibilidade_pedido where conversa_id = $1`, [q2.c]);
  const msg = await um(`select texto from public.mensagens where conversa_id = $1 and autor = 'agente' and opcoes ->> 'tipo' = 'disponibilidade_registrada' order by id desc limit 1`, [q2.c]);
  const nota = await um(`select dados -> 'notas' as n from public.conversa_fluxo where conversa_id = $1`, [q2.c]);
  return { ok: r.ok === true && d.profissional_preferido === DRA_A && d.aceita_outros_profissionais === false && d.aceita_notificacao === false && d.estado === 'ativa' && d.turno === 'manha' && JSON.stringify(d.dias_semana) === '[1,3]' && d.df === dia(30) && d.di === dia(1)
                && /até \d{2}\/\d{2}, de manhã, seg, qua/.test(msg.texto) && /de manhã, seg, qua/.test(JSON.stringify(nota.n))
                && /não tem horário disponível nos próximos 45 dias/.test(msg.texto) && /não vamos trocar de médico/.test(msg.texto) && /NÃO é um agendamento/.test(msg.texto) && /MÉDICO ESCOLHIDO SEM HORÁRIO/.test(JSON.stringify(nota.n)),
           detalhe: JSON.stringify(d) };
});
await caso('não abre quando a API TEM horário do médico escolhido (o paciente deve escolher um)', async () => {
  const x = await ateOCalendario(telefone()); await ativar(x); await escolheMedico(x.c, DRA_A);
  await ofertar(x.c, [[dia(4), '09:00', DRA_A]]); await consulta(x.c, 'ok_com_horarios');
  await anonimo(); const e = await erroDe(() => rpc('chat_medico_sem_horario_abrir', { p_conversa: x.c, p_token: x.t, p_dados: { data_fim: dia(30) } })); await como('');
  return { ok: e && /Há horários desse médico/.test(e.msg), detalhe: JSON.stringify(e) };
});
await caso('não abre sem médico escolhido, nem com token errado', async () => {
  const x = await ateOCalendario(telefone()); await ativar(x);
  await ofertar(x.c, [[dia(4), '09:00', DRA_B]]); await consulta(x.c, 'ok_com_horarios');
  await anonimo(); const e1 = await erroDe(() => rpc('chat_medico_sem_horario_abrir', { p_conversa: x.c, p_token: x.t, p_dados: { data_fim: dia(30) } })); await como('');
  await escolheMedico(x.c, DRA_A); await db.query(`delete from public.klingo_oferta where conversa_id = $1`, [x.c]);
  await anonimo(); const e2 = await erroDe(() => rpc('chat_medico_sem_horario_abrir', { p_conversa: x.c, p_token: 'token-errado', p_dados: { data_fim: dia(30) } })); await como('');
  return { ok: e1 && /não tem médico escolhido/.test(e1.msg) && e2, detalhe: `${JSON.stringify(e1)} | ${JSON.stringify(e2)}` };
});
await caso('sem o prazo ("até que dia") ou com o prazo antes do início, recusa e não cria nada; a função de 2 parâmetros não existe mais', async () => {
  const x = await ateOCalendario(telefone()); await ativar(x); await escolheMedico(x.c, DRA_A);
  await ofertar(x.c, [[dia(4), '09:00', DRA_B]]); await consulta(x.c, 'ok_com_horarios');
  await anonimo();
  const e1 = await erroDe(() => rpc('chat_medico_sem_horario_abrir', { p_conversa: x.c, p_token: x.t, p_dados: { turno: 'tarde' } }));
  const e2 = await erroDe(() => rpc('chat_medico_sem_horario_abrir', { p_conversa: x.c, p_token: x.t, p_dados: { data_ini: dia(10), data_fim: dia(5) } }));
  await como('');
  const n = (await um(`select count(*)::int n from public.disponibilidade_pedido where conversa_id = $1`, [x.c])).n;
  const f = (await um(`select count(*)::int n from pg_proc where proname = 'chat_medico_sem_horario_abrir'`)).n;
  return { ok: e1 && /até que dia/.test(e1.msg) && e2 && /data final/.test(e2.msg) && n === 0 && f === 1, detalhe: `${JSON.stringify(e1)} | ${JSON.stringify(e2)} | pedidos=${n}; funções=${f}` };
});
await caso('o formulário de disponibilidade (registrar e alterar) também fica só com o médico escolhido, mesmo que o chat peça "aceito outros"', async () => {
  const x = await ateOCalendario(telefone()); await ativar(x); await escolheMedico(x.c, DRA_A);
  await ofertar(x.c, [[dia(4), '09:00', DRA_B]]); await consulta(x.c, 'ok_com_horarios');
  await anonimo();
  const r = await rpc('chat_disponibilidade_registrar', { p_conversa: x.c, p_token: x.t, p_dados: { data_ini: dia(1), data_fim: dia(30), aceita_outros_profissionais: true, profissional: DRA_B } });
  await rpc('chat_disponibilidade_alterar', { p_conversa: x.c, p_token: x.t, p_id: r.solicitacao.id, p_dados: { data_ini: dia(2), data_fim: dia(40), aceita_outros_profissionais: true, profissional: DRA_B } });
  await como('');
  const d = await um(`select profissional_preferido, aceita_outros_profissionais from public.disponibilidade_pedido where id = $1`, [r.solicitacao.id]);
  return { ok: d.profissional_preferido === DRA_A && d.aceita_outros_profissionais === false, detalhe: JSON.stringify(d) };
});

const falhou = resultados.filter((x) => !x).length;
console.log(falhou ? `\n${falhou} FALHA(S)` : `\nTodos os ${resultados.length} testes passaram.`);
await db.close?.();
process.exit(falhou ? 1 : 0);
