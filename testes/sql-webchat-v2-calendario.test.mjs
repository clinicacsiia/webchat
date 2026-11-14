// FLUXOGRAMA: entrada (clone da produção de 14/11/2026 + webchat-v2-parte1 e parte2; catálogo e GRADE inventados com muitos horários; ofertas da API inventadas) -> validação (um paciente de mentira percorre o chat até o calendário pelas funções reais)
//   -> processamento (chat_horarios e chat_horario_escolher em cada estado da API; previsao_buscar; pedido_horario_vigiar) -> persistência (só no clone) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Prova o critério 1 e 2: nenhum horário calculado pela grade aparece como vaga; o calendário mostra só ofertas válidas da API; sem oferta não vira falsa disponibilidade.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
let sqlErro = null;
for (const f of ['webchat-v2-parte1-modos', 'webchat-v2-parte2-calendario-api']) {
  try { await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8')); } catch (e) { sqlErro = `${f}: ${String(e.message).split('\n')[0]}`; }
}
registrar('o retrato da produção monta inteiro e as partes 1 e 2 do WebChat v2 aplicam sem erro', falhas.length === 0 && !sqlErro, sqlErro ?? '');

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

await cfg('klingo_auto', 'sim'); await cfg('klingo_api_telefones_teste', TESTE); await cfg('klingo_api_percentual', '100');

// ---------------------------------------------------------------------------------------------- A. a grade não é vaga
let comum, lista;
await caso('CRITÉRIO 1: com a API desligada (nao) o calendário NÃO mostra os horários da grade, mesmo havendo grade; vem estado "nao_integrado" e o aviso certo', async () => {
  await cfg('klingo_api_horarios', 'nao'); comum = await ateOCalendario();
  const grade = await um(`select count(*)::int n from public.agenda_horarios(array[201], current_date, current_date + 20, null, null, null, '[]'::jsonb)`);
  const r = await horarios(comum);
  return { ok: grade.n > 0 && slots(r).length === 0 && r.estado === 'nao_integrado' && r.klingo_api === false && r.origem === 'nenhuma' && /agendado pela nossa equipe/.test(r.aviso),
           detalhe: `a grade teria ${grade.n} horários; o calendário mostra ${slots(r).length}; estado=${r.estado}` };
});
await caso('modo SOMBRA: nem a grade nem as ofertas medidas aparecem para o paciente comum', async () => {
  await cfg('klingo_api_horarios', 'sombra');
  await ofertar(comum.c, [[dia(3), '08:00'], [dia(3), '09:00']], true); await consulta(comum.c, 'ok_com_horarios', 'sombra');
  const r = await horarios(comum);
  return { ok: slots(r).length === 0 && r.estado === 'nao_integrado', detalhe: `slots=${slots(r).length}; estado=${r.estado}` };
});

// ---------------------------------------------------------------------------------------------- B. só ofertas válidas da API
await caso('CRITÉRIO 2: com a API ativa e 3 ofertas, o calendário mostra EXATAMENTE as 3 (não os ~8 por dia da grade), com a chave da oferta e origem "api_klingo"', async () => {
  await cfg('klingo_api_horarios', 'teste'); lista = await ateOCalendario(TESTE);
  const ofs = [[dia(3), '08:30'], [dia(3), '10:00'], [dia(5), '11:30']];
  await ofertar(lista.c, ofs); await consulta(lista.c, 'ok_com_horarios');
  const r = await horarios(lista);
  const esperado = ofs.map(([d, h]) => `${d} ${h}`).sort(), obtido = slots(r).sort();
  return { ok: JSON.stringify(esperado) === JSON.stringify(obtido) && r.estado === 'com_horarios' && r.klingo_api === true && r.origem === 'api_klingo' && r.dias[0].slots[0].oferta, detalhe: `esperado ${esperado.length}; obtido ${obtido.length}; estado=${r.estado}` };
});
await caso('ESTADO DE API: API respondeu sem horários => "sem_horarios" com a mensagem pedida (não confundir com falha técnica)', async () => {
  const p = await ateOCalendario(telefone()); await ativar(p);
  await consulta(p.c, 'api_sem_horarios');
  const r = await horarios(p);
  return { ok: r.estado === 'sem_horarios' && slots(r).length === 0 && r.aviso === 'Não encontramos horários disponíveis para esse atendimento no momento.', detalhe: `estado=${r.estado}; aviso=${r.aviso}` };
});
await caso('ESTADO DE API: todos os horários filtrados também é "sem_horarios"; estrutura inválida, erro e limite são "indisponivel" (falha técnica)', async () => {
  const p = await ateOCalendario(telefone()); await ativar(p);
  const out = {};
  for (const res of ['todos_filtrados', 'estrutura_invalida', 'erro_api', 'limite', 'erro_gravacao', 'sem_traducao_plano', 'fora_do_escopo', 'dados_incompletos']) {
    await consulta(p.c, res); out[res] = (await horarios(p)).estado;
  }
  const esperado = { todos_filtrados: 'sem_horarios', estrutura_invalida: 'indisponivel', erro_api: 'indisponivel', limite: 'indisponivel', erro_gravacao: 'indisponivel', sem_traducao_plano: 'nao_integrado', fora_do_escopo: 'nao_integrado', dados_incompletos: 'nao_integrado' };
  return { ok: JSON.stringify(out) === JSON.stringify(esperado), detalhe: JSON.stringify(out) };
});
await caso('sem nenhuma consulta recente o estado é "sem_consulta" (a tela consulta a API antes de decidir) e nunca mostra a grade', async () => {
  const p = await ateOCalendario(telefone()); await ativar(p);
  const r = await horarios(p);
  return { ok: r.estado === 'sem_consulta' && slots(r).length === 0, detalhe: `estado=${r.estado}` };
});
await caso('oferta VENCIDA ou no PASSADO não aparece; filtros de período e unidade valem sobre as ofertas', async () => {
  await db.query(`update public.klingo_oferta set expira_em = now() - interval '1 minute' where conversa_id = $1 and hora = '11:30'`, [lista.c]);
  const manha = await horarios(lista, { p_periodo: 'manha' }), tarde = await horarios(lista, { p_periodo: 'tarde' }), outraUnidade = await horarios(lista, { p_unidade: 'OUTRA UNIDADE' });
  return { ok: slots(manha).length === 2 && slots(tarde).length === 0 && slots(outraUnidade).length === 0, detalhe: `manhã=${slots(manha).length} (11:30 venceu); tarde=${slots(tarde).length}; outra unidade=${slots(outraUnidade).length}` };
});

// ---------------------------------------------------------------------------------------------- C. escolha
await caso('ESCOLHA: só uma oferta real; guarda a chave da oferta e a origem; o texto NÃO diz que está marcado', async () => {
  const dado = await ofertar(lista.c, [[dia(3), '08:30'], [dia(3), '10:00'], [dia(5), '11:30']]);
  const r = await escolher(lista, dia(3), '10:00');
  const pa = await um(`select escolha_horario from public.pre_agendamentos where conversa_id = $1`, [lista.c]);
  const msg = await um(`select texto from public.mensagens where conversa_id = $1 and autor = 'cliente' order by id desc limit 1`, [lista.c]);
  const e = pa.escolha_horario[0];
  return { ok: r.ok === true && e.klingo_chave === `${dia(3)}|63|308|2|10:00` && e.origem === 'klingo_api' && !/agendad[oa]\b(?!.*falta)/i.test(msg.texto.replace(/ainda não está marcado/, '')) && /ainda não está marcado|equipe confirma/.test(msg.texto), detalhe: msg.texto.slice(-90) };
});
await caso('ESCOLHA de horário que só existe na GRADE (ex.: 08:00, sem oferta) é recusada: "acabou de ficar indisponível" (P0002)', async () => {
  const e = await erroDe(() => escolher(lista, dia(3), '08:00'));
  return { ok: e && e.code === 'P0002' && /indispon/.test(e.msg), detalhe: JSON.stringify(e) };
});
await caso('ESCOLHA de oferta VENCIDA enquanto o paciente decidia é recusada (a marcação nunca nasce de oferta velha)', async () => {
  await db.query(`update public.klingo_oferta set expira_em = now() - interval '1 second' where conversa_id = $1 and hora = '08:30'`, [lista.c]);
  const e = await erroDe(() => escolher(lista, dia(3), '08:30'));
  return { ok: e && e.code === 'P0002', detalhe: JSON.stringify(e) };
});
await caso('ESCOLHA de oferta de SOMBRA é recusada', async () => {
  await ofertar(lista.c, [[dia(6), '09:00']], true);
  const e = await erroDe(() => escolher(lista, dia(6), '09:00'));
  return { ok: e && e.code === 'P0002', detalhe: JSON.stringify(e) };
});
await caso('ESCOLHA em conversa sem a API ativa (comum, modo teste) é recusada com a mensagem de atendimento pela equipe', async () => {
  const e = await erroDe(() => escolher(comum, dia(3), '08:00'));
  return { ok: e && e.code === 'P0001' && /equipe/.test(e.msg), detalhe: JSON.stringify(e) };
});
await caso('token errado não lê nem escolhe horário de outra conversa (28000)', async () => {
  await anonimo();
  const e = await erroDe(() => rpc('chat_horarios', { p_conversa: lista.c, p_token: 'token-errado', p_grupo: 1, p_de: dia(0), p_ate: dia(10) }));
  await como('');
  return { ok: e && e.code === '28000', detalhe: JSON.stringify(e) };
});

// ---------------------------------------------------------------------------------------------- D. vários exames
await caso('VÁRIOS EXAMES: sem operação composta suportada pela API => "nao_integrado" (varios_procedimentos), pedido preservado', async () => {
  const p = await ateOCalendario(); await ativar(p);
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, lado, procedimento_id, procedimento) values ($1, 'US', 'abdome', 'N', 202, 'ULTRASSONOGRAFIA DE ABDOME TOTAL')`, [p.c]);
  await ofertar(p.c, [[dia(3), '08:30']]); await consulta(p.c, 'ok_com_horarios');
  const r = await horarios(p);
  const itens = (await um(`select count(*)::int n from public.pre_agendamento_itens where conversa_id = $1 and ativo`, [p.c])).n;
  return { ok: itens === 2 && r.estado === 'nao_integrado' && r.estado_motivo === 'varios_procedimentos' && slots(r).length === 0, detalhe: `itens=${itens}; grupos=${r.grupos.length}; estado=${r.estado}/${r.estado_motivo}` };
});

// ---------------------------------------------------------------------------------------------- E. previsão antiga e oferta automática
await caso('previsao_buscar devolve só OFERTAS DA API (turno e antecedência respeitados) e lista vazia quando não há oferta, mesmo havendo grade', async () => {
  const p = await ateOCalendario(telefone()); await ativar(p);
  const vazio = await um(`select public.previsao_buscar($1, 'qualquer', current_date, current_date + 20, 0) r`, [p.c]);
  await ofertar(p.c, [[dia(4), '08:30'], [dia(4), '15:00'], [dia(6), '09:00']]);
  const manha = await um(`select public.previsao_buscar($1, 'manha', current_date, current_date + 20, 0) r`, [p.c]);
  const tarde = await um(`select public.previsao_buscar($1, 'tarde', current_date, current_date + 20, 0) r`, [p.c]);
  const longe = await um(`select public.previsao_buscar($1, 'qualquer', current_date, current_date + 20, 60*24*30) r`, [p.c]);
  return { ok: vazio.r.length === 0 && manha.r.length === 2 && manha.r.every((s) => s.hora < '12:00' && s.oferta) && tarde.r.length === 1 && tarde.r[0].hora === '15:00' && longe.r.length === 0,
           detalhe: `sem oferta=${vazio.r.length}; manhã=${manha.r.length}; tarde=${tarde.r.length}; antecedência de 30 dias=${longe.r.length}` };
});
await caso('pedido_horario_vigiar NÃO oferece mais horário da grade: pedido com data que passou vira alerta para a equipe, sem "oferta pendente"', async () => {
  const p = await ateOCalendario(telefone());
  await cfg('pedido_horario_modo', 'ligado');
  await db.query(`update public.pre_agendamentos set status = 'pronto', escolha_horario = '[{"grupo":1,"data":"2020-01-02","hora":"08:00"}]'::jsonb where conversa_id = $1`, [p.c]);
  await db.query(`update public.conversas set status = 'aguardando' where id = $1`, [p.c]);
  const r = await um(`select public.pedido_horario_vigiar() r`);
  const f = await um(`select dados -> 'oferta_pendente' as of from public.conversa_fluxo where conversa_id = $1`, [p.c]);
  const cv = await um(`select alerta_agenda from public.conversas where id = $1`, [p.c]);
  return { ok: r.r.ofertas === 0 && (f.of === null || f.of === undefined) && /Pedido sem horário/.test(cv.alerta_agenda ?? ''), detalhe: `ofertas=${r.r.ofertas}; avisos à equipe=${r.r.avisos_sem_horario}; alerta="${(cv.alerta_agenda ?? '').slice(0, 40)}"` };
});

console.log(`\n${resultados.filter(Boolean).length} de ${resultados.length} verificações passaram.`);
process.exit(resultados.every(Boolean) ? 0 : 1);
