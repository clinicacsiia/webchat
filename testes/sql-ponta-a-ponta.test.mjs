// FLUXOGRAMA: entrada (o retrato da produção montado num Postgres embutido + um catálogo inventado) -> validação (um "paciente" de mentira percorre o chat pelas MESMAS funções que o index.html chama, como papel anon; uma "atendente" de mentira assume, responde e encerra como papel authenticated) -> lógica (confere em cada passo o que o assistente pergunta, o que fica gravado e o que cada papel consegue ou não ver) -> saída (PASS/FAIL por verificação; código de saída 1 se algo falhar)
// Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial (auditoria de 11/11/2026)
//
// É o teste que prova "do Começar ao pedido enviado" com o CÓDIGO REAL do banco de produção (supabase/producao/), não com cópias antigas.
// Dados: todos inventados aqui. Nenhuma linha vem da produção.
// O que NÃO prova: a tela (isso é dos testes *.navegador.mjs), o Klingo, o push e o tempo real por WebSocket.
import { criarBancoProducao, ajudantes } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);

const ADMIN = '00000000-0000-4000-8000-0000000000a1', ATEND = '00000000-0000-4000-8000-0000000000a2', OUTRO_PACIENTE = '00000000-0000-4000-8000-0000000000b1';
const UNIDADE = 'CLÍNICA DE SAÚDE E IMAGEM - CSI';
await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}', 'admin@exemplo.invalid'), ('${ATEND}', 'atendente@exemplo.invalid'), ('${OUTRO_PACIENTE}', 'paciente@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADMIN}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true), ('${ATEND}', 'Ana Atendente', 'atendente@exemplo.invalid', 'atendente', true);
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!'), ('reabrir_dias', '2')
    on conflict (chave) do update set valor = excluded.valor;
  insert into public.catalogo_regiao (codigo, nome, padrao, tem_lado, grupo, ordem) values ('joelho', 'Joelho', 'JOELHO', true, 'perna', 1), ('abdome', 'Abdome', 'ABDOME', false, 'tronco', 2);
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values
    (201, 'RESSONANCIA MAGNETICA DO JOELHO (UNILATERAL)', 'RESSONANCIA MAGNETICA', true, 9, ''), (202, 'ULTRASSONOGRAFIA DE ABDOME TOTAL', 'ULTRASSONOGRAFIA', true, 7, ''),
    (301, 'CONSULTA', 'CONSULTAS', true, 20, '');
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select p.id, p.nome, '${UNIDADE}', case when p.id = 201 then 'RESSONANCIA' when p.id = 202 then 'ULTRASSOM 1' else 'CONSULTORIO 1' end,
           case when p.id = 301 then m.med else 'DRA EXEMPLO IMAGEM' end, case when p.id = 301 then 'CARDIOLOGIA' else 'RADIOLOGIA' end, d, '08:00', '12:00', 30, current_date - 30, current_date + 300
    from public.catalogo_procedimento p cross join generate_series(0, 6) d cross join (values ('DR EXEMPLO UM'), ('DRA EXEMPLO DOIS')) m(med)
    where (p.id <> 301 and m.med = 'DR EXEMPLO UM') or p.id = 301;
`);

// ---------------------------------------------------------------- o paciente de mentira (só as funções que o chat chama, como anon)
const CAMPO = (c) => (c.tipo === 'sexo' ? 'F' : c.tipo === 'data' ? '25/03/1980' : c.tipo === 'cpf' ? '111.444.777-35' : c.tipo === 'tel' ? '(71) 99999-0001' : c.tipo === 'email' ? 'maria@exemplo.invalid'
  : c.tipo === 'cep' ? '40000-000' : c.tipo === 'uf' ? 'BA' : c.nome === 'nome' ? 'Maria Teste da Silva' : c.nome === 'mae' ? 'Ana Teste da Silva' : c.nome === 'numero' ? '10' : 'Texto de teste');
let nTel = 0;
const telefone = () => '7198' + String(7000000 + ++nTel);
const rpc = async (nome, args) => {   // como o supabase-js: chama a função com parâmetros nomeados
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  const r = await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k])));
  return r[0].r;
};
async function iniciar(nome = 'Maria Teste da Silva', tel = telefone()) {
  await anonimo();
  const r = await rpc('chat_iniciar', { p_nome: nome, p_telefone: tel, p_email: 'maria@exemplo.invalid', p_aceite: true, p_paciente_tipo: 'proprio' });
  return { c: r.conversa_id, t: r.token, tel, ult: r.respostas.at(-1), passos: [r.respostas.at(-1).opcoes.passo], motor: r.motor };
}
// Responde a pergunta em aberto. escolhas = { passo: valor } (o resto vai pela primeira opção). Devolve false quando chega ao fim.
async function responder(p, escolhas = {}) {
  const o = p.ult.opcoes; let r;
  if (!o || o.tipo === 'acompanhar') return false;
  await anonimo();
  if (o.tipo === 'escolha') {
    const quer = escolhas[o.passo];
    const item = (o.itens || []).find((x) => x.valor === quer) || (quer === undefined ? (o.itens || [])[0] : null);
    if (!item) throw new Error(`passo ${o.passo}: opção ${JSON.stringify(quer)} não oferecida (${(o.itens || []).map((x) => x.valor).join(', ')})`);
    r = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify(item.valor), p_texto: item.rotulo });
  } else if (o.tipo === 'campos') {
    const v = {}; for (const cp of o.campos || []) v[cp.nome] = CAMPO(cp);
    r = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: v, p_texto: null });
  } else if (o.tipo === 'pedido_consulta') {
    const cs = await rpc('chat_consultas', { p_conversa: p.c, p_token: p.t });
    r = await rpc('chat_consulta_salvar', { p_conversa: p.c, p_token: p.t, p_procedimento_id: cs.consultas[0].id });
  } else if (o.tipo === 'busca_exame' || o.tipo === 'pedido_exames') {
    const ex = await rpc('chat_exames', { p_conversa: p.c, p_token: p.t, p_modalidade: 'RM', p_regiao: 'joelho' });
    r = await rpc('chat_pedido_enviar', { p_conversa: p.c, p_token: p.t, p_itens: [{ modalidade: 'RM', regiao: 'joelho', lado: 'D', procedimento_id: ex[0].id }] });
  } else if (o.tipo === 'calendario') {
    const hs = await rpc('chat_horarios', { p_conversa: p.c, p_token: p.t, p_grupo: o.grupo || 1, p_de: dia(0), p_ate: dia(20) });
    p.horarios = hs;
    if (escolhas.horario === 'sem_horario') r = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify('sem_horario'), p_texto: 'Nenhum horário serve para mim' });
    else {
      const d = hs.dias[escolhas.diaIndice || 0], s = d.slots[0];
      p.escolhido = { data: d.data, hora: s.hora, unidade: s.unidade, profissional: s.profissional };
      r = await rpc('chat_horario_escolher', { p_conversa: p.c, p_token: p.t, p_grupo: o.grupo || 1, p_data: d.data, p_hora: s.hora, p_unidade: s.unidade });
    }
  } else throw new Error(`tipo de pergunta não tratado pelo teste: ${o.tipo}`);
  let resp = (r && r.respostas) || [];
  if (!resp.length) resp = (await rpc('chat_listar', { p_conversa: p.c, p_token: p.t, p_apos: p.ult.id })).mensagens || [];
  const ag = resp.filter((m) => m.autor === 'agente');
  if (!ag.length) throw new Error(`o assistente não respondeu depois de ${o.passo}`);
  p.ult = ag.at(-1);
  p.passos.push(p.ult.opcoes ? (p.ult.opcoes.passo || p.ult.opcoes.tipo) : 'texto');
  return true;
}
async function ateOFim(p, escolhas) { for (let i = 0; i < 30 && await responder(p, escolhas); i++); await como(''); return p; }
const dia = (n) => { const d = new Date(Date.now() + n * 864e5); return d.toLocaleString('sv-SE', { timeZone: 'America/Bahia' }).slice(0, 10); };
const pedidoDe = (c) => um(`select status, etapa, tipo, plano, procedimento, profissional, jsonb_array_length(coalesce(escolha_horario, '[]'::jsonb))::int as horarios, paciente from public.pre_agendamentos where conversa_id = $1`, [c]);
const conversaDe = (c) => um(`select status, ia_ativa, agente_id, motivo_encerramento, encerramento_origem, primeiro_humano_em, encerrada_em from public.conversas where id = $1`, [c]);
const erroDe = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, msg: String(e.message).split('\n')[0] }; } };

// ---------------------------------------------------------------- 1. caminhos completos
let exame, consulta;
await caso('EXAME particular, do "Começar" ao pedido enviado: motivo > exame > plano > horário > dados > confirmação > acompanhamento', async () => {
  exame = await ateOFim(await iniciar(), { motivo: 'exame', plano: 'Particular', confirmar: 'ok' });
  const pa = await pedidoDe(exame.c), cv = await conversaDe(exame.c);
  const esperado = 'motivo > exame > plano > horario > dados_ident > dados_contato > confirmar > acompanhar';
  return { ok: exame.passos.join(' > ') === esperado && pa.status === 'pronto' && pa.tipo === 'exame' && pa.plano === 'Particular' && pa.horarios === 1 && /JOELHO/.test(pa.procedimento)
    && pa.paciente.nome === 'Maria Teste da Silva' && cv.status === 'aguardando' && cv.ia_ativa === false, detalhe: exame.passos.join(' > ') };
});
await caso('CONSULTA com escolha de médico: motivo > consulta > médico > plano > horário > dados > confirmação > acompanhamento', async () => {
  consulta = await ateOFim(await iniciar('Carlos Teste Pereira'), { motivo: 'consulta', medico: 'DRA EXEMPLO DOIS', plano: 'Particular', confirmar: 'ok' });
  const pa = await pedidoDe(consulta.c);
  const esperado = 'motivo > consulta > medico > plano > horario > dados_ident > dados_contato > confirmar > acompanhar';
  return { ok: consulta.passos.join(' > ') === esperado && pa.status === 'pronto' && pa.tipo === 'consulta' && pa.horarios === 1 && consulta.escolhido.profissional === 'DRA EXEMPLO DOIS',
    detalhe: `${consulta.passos.join(' > ')} | médico do horário: ${consulta.escolhido.profissional}` };
});
await caso('"Nenhum horário serve para mim": o pedido segue sem horário e chega à equipe do mesmo jeito', async () => {
  const p = await ateOFim(await iniciar('Sem Horario Teste'), { motivo: 'exame', plano: 'Particular', horario: 'sem_horario', confirmar: 'ok' });
  const pa = await pedidoDe(p.c);
  return { ok: p.passos.at(-1) === 'acompanhar' && pa.status === 'pronto' && pa.horarios === 0, detalhe: p.passos.join(' > ') };
});
await caso('o que o paciente escolheu fica guardado sem perder nada: mensagens em ordem, pedido com exame, lado e horário', async () => {
  const ms = await q(`select autor, left(texto, 30) t from public.mensagens where conversa_id = $1 order by id`, [exame.c]);
  const it = await um(`select modalidade, regiao, lado, procedimento_id, ativo from public.pre_agendamento_itens where conversa_id = $1 and ativo`, [exame.c]);
  const alterna = ms.filter((m) => m.autor !== 'sistema').every((m, i, a) => i === 0 || m.autor !== a[i - 1].autor || m.autor === 'agente');
  return { ok: ms.length >= 14 && ms[0].autor === 'agente' && alterna && it.modalidade === 'RM' && it.regiao === 'joelho' && it.lado === 'D' && it.procedimento_id === 201, detalhe: `${ms.length} mensagens; item=${JSON.stringify(it)}` };
});

// ---------------------------------------------------------------- 2. agenda: o horário escolhido fica reservado
await caso('AGENDA: o horário que um paciente escolheu deixa de ser oferecido a outro (reserva provisória)', async () => {
  const outro = await iniciar('Outro Paciente Teste');
  for (let i = 0; i < 6 && outro.ult.opcoes.tipo !== 'calendario'; i++) await responder(outro, { motivo: 'exame', plano: 'Particular' });
  await anonimo();
  const hs = await rpc('chat_horarios', { p_conversa: outro.c, p_token: outro.t, p_grupo: 1, p_de: dia(0), p_ate: dia(20) });
  const mesmoDia = hs.dias.find((d) => d.data === exame.escolhido.data);
  const aindaOferece = !!mesmoDia && mesmoDia.slots.some((s) => s.hora === exame.escolhido.hora && s.profissional === exame.escolhido.profissional);
  const e = await erroDe(() => rpc('chat_horario_escolher', { p_conversa: outro.c, p_token: outro.t, p_grupo: 1, p_data: exame.escolhido.data, p_hora: exame.escolhido.hora, p_unidade: exame.escolhido.unidade }));
  await como('');
  return { ok: !aindaOferece && !!e, detalhe: `oferecido ao outro=${aindaOferece}; tentar pegar mesmo assim: ${e ? e.msg.slice(0, 70) : 'ACEITOU'}` };
});

// ---------------------------------------------------------------- 3. travas do chat (as mesmas que protegem a produção)
await caso('token errado, conversa de outro paciente e leitura direta das tabelas: tudo recusado para o paciente (anon)', async () => {
  await anonimo();
  const e1 = await erroDe(() => rpc('chat_listar', { p_conversa: exame.c, p_token: 'token-errado', p_apos: 0 }));
  const e2 = await erroDe(() => rpc('chat_listar', { p_conversa: exame.c, p_token: consulta.t, p_apos: 0 }));   // token de OUTRA conversa
  const e3 = await erroDe(() => rpc('chat_enviar', { p_conversa: exame.c, p_token: consulta.t, p_texto: 'oi' }));
  const linhas = [];
  for (const tb of ['conversas', 'mensagens', 'pre_agendamentos', 'pacientes', 'contatos', 'conversa_segredo', 'config']) {
    const e = await erroDe(async () => { linhas.push((await q(`select count(*)::int n from public.${tb}`))[0].n); });
    if (e) linhas.push('negado');
  }
  await como('');
  return { ok: e1.code === '28000' && e2.code === '28000' && e3.code === '28000' && linhas.every((x) => x === 0 || x === 'negado'), detalhe: `tabelas vistas pelo anon: ${linhas.join(', ')}` };
});
await caso('paciente LOGADO (conta de paciente, não é da equipe) também não lê conversas, mensagens nem cadastros de ninguém', async () => {
  await como(OUTRO_PACIENTE);
  const linhas = [];
  for (const tb of ['conversas', 'mensagens', 'pre_agendamentos', 'pacientes', 'contatos', 'config', 'agentes']) {
    const e = await erroDe(async () => { linhas.push((await q(`select count(*)::int n from public.${tb}`))[0].n); });
    if (e) linhas.push('negado');
  }
  const e = await erroDe(() => q(`update public.conversas set status = 'encerrada' where id = $1`, [exame.c]));
  await como('');
  const cv = await conversaDe(exame.c);
  return { ok: linhas.every((x) => x === 0 || x === 'negado') && cv.status === 'aguardando', detalhe: `linhas vistas: ${linhas.join(', ')}; status depois da tentativa de encerrar=${cv.status}` };
});
await caso('limite de 20 mensagens por minuto por conversa (erro 54000, não derruba a conversa)', async () => {
  const p = await iniciar('Limite Teste');
  await anonimo();
  let e = null, n = 0;
  for (; n < 25 && !e; n++) e = await erroDe(() => rpc('chat_enviar', { p_conversa: p.c, p_token: p.t, p_texto: `mensagem ${n}` }));
  const l = await rpc('chat_listar', { p_conversa: p.c, p_token: p.t, p_apos: 0 });
  await como('');
  return { ok: !!e && e.code === '54000' && n <= 21 && Array.isArray(l.mensagens), detalhe: `recusou na ${n}ª mensagem: ${e && e.msg.slice(0, 50)}` };
});
await caso('limite de 5 conversas por hora por telefone (erro 54000)', async () => {
  const tel = telefone(); let e = null, n = 0;
  for (; n < 8 && !e; n++) e = await erroDe(async () => { await iniciar('Repetido Teste', tel); });
  await como('');
  return { ok: !!e && e.code === '54000' && n === 6, detalhe: `recusou na ${n}ª conversa` };
});
await caso('dados inválidos são recusados com mensagem (22023), não com erro interno: nome curto, telefone curto, sem aceite', async () => {
  await anonimo();
  const es = [
    await erroDe(() => rpc('chat_iniciar', { p_nome: 'A', p_telefone: telefone(), p_email: 'a@exemplo.invalid', p_aceite: true })),
    await erroDe(() => rpc('chat_iniciar', { p_nome: 'Maria Teste', p_telefone: '123', p_email: 'a@exemplo.invalid', p_aceite: true })),
    await erroDe(() => rpc('chat_iniciar', { p_nome: 'Maria Teste', p_telefone: telefone(), p_email: 'a@exemplo.invalid', p_aceite: false })),
  ];
  await como('');
  return { ok: es.every((e) => e && e.code === '22023'), detalhe: es.map((e) => (e ? e.code : 'ACEITOU')).join(', ') };
});

// ---------------------------------------------------------------- 4. a equipe assume, responde e encerra (como a atendente logada)
let meio;
await caso('a atendente ASSUME no meio de uma pergunta do assistente: entra a mensagem "entrou na conversa" e o assistente para', async () => {
  meio = await iniciar('Meio do Caminho Teste');
  await responder(meio, { motivo: 'exame' });   // parou na pergunta "exame"
  await como(ATEND);
  await q(`update public.conversas set status = 'em_atendimento', agente_id = $2 where id = $1`, [meio.c, ATEND]);
  await como('');
  const cv = await conversaDe(meio.c);
  const sis = await um(`select texto from public.mensagens where conversa_id = $1 and autor = 'sistema' order by id desc limit 1`, [meio.c]);
  await anonimo();
  const l = await rpc('chat_listar', { p_conversa: meio.c, p_token: meio.t, p_apos: 0 });
  await como('');
  return { ok: cv.status === 'em_atendimento' && cv.agente_id === ATEND && !!cv.primeiro_humano_em && /Ana Atendente/.test(sis ? sis.texto : '') && l.motor_ativo === false && l.status === 'em_atendimento' && l.agente === 'Ana Atendente',
    detalhe: `sistema="${sis && sis.texto}" motor_ativo=${l.motor_ativo}` };
});
await caso('REGRA QUE A TELA PASSOU A RESPEITAR: com a equipe na conversa, responder à pergunta antiga do assistente é recusado (22023)', async () => {
  await anonimo();
  const e = await erroDe(() => rpc('chat_responder', { p_conversa: meio.c, p_token: meio.t, p_passo: 'exame', p_valor: JSON.stringify('x'), p_texto: 'x' }));
  const ok = await erroDe(() => rpc('chat_enviar', { p_conversa: meio.c, p_token: meio.t, p_texto: 'Oi, pode me ajudar?' }));   // texto livre continua valendo
  await como('');
  return { ok: !!e && e.code === '22023' && /já foi respondida/.test(e.msg) && ok === null, detalhe: `${e && e.msg} | texto livre: ${ok ? ok.msg : 'aceito'}` };
});
await caso('a atendente responde e o paciente recebe; mensagem do paciente volta para a atendente (não lidas)', async () => {
  await como(ATEND);
  await q(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, 'agente', $2, 'Olá! Sou a Ana e vou te ajudar.')`, [meio.c, ATEND]);
  await anonimo();
  const l = await rpc('chat_listar', { p_conversa: meio.c, p_token: meio.t, p_apos: 0 });
  const viu = l.mensagens.some((m) => m.autor === 'agente' && /Sou a Ana/.test(m.texto) && m.agente === 'Ana Atendente');
  await rpc('chat_enviar', { p_conversa: meio.c, p_token: meio.t, p_texto: 'Obrigada!' });
  await como(ATEND);
  const cv = await um(`select nao_lidas_agente, ultima_mensagem from public.conversas where id = $1`, [meio.c]);
  await como('');
  return { ok: viu && cv.nao_lidas_agente >= 1 && /Obrigada/.test(cv.ultima_mensagem), detalhe: JSON.stringify(cv) };
});
await caso('atendente NÃO envia mensagem em nome de outra pessoa nem como "cliente" (regra de acesso da tabela)', async () => {
  await como(ATEND);
  const e1 = await erroDe(() => q(`insert into public.mensagens (conversa_id, autor, agente_id, texto) values ($1, 'agente', $2, 'falsa')`, [meio.c, ADMIN]));
  const e2 = await erroDe(() => q(`insert into public.mensagens (conversa_id, autor, texto) values ($1, 'cliente', 'falsa')`, [meio.c]));
  await como('');
  return { ok: !!e1 && !!e2, detalhe: `${e1 ? 'recusado' : 'ACEITOU'} / ${e2 ? 'recusado' : 'ACEITOU'}` };
});
await caso('encerrar exige motivo; com motivo encerra, grava quem/quando/origem, registra o fechamento e manda a despedida', async () => {
  await como(ATEND);
  const semMotivo = await erroDe(() => q(`update public.conversas set status = 'encerrada' where id = $1`, [meio.c]));
  await q(`update public.conversas set status = 'encerrada', motivo_encerramento = 'apenas_informacoes' where id = $1`, [meio.c]);
  await como('');
  const cv = await conversaDe(meio.c);
  const fech = await um(`select count(*)::int n from public.conversa_encerramento where conversa_id = $1`, [meio.c]);
  const ev = (await q(`select tipo from public.conversa_evento where conversa_id = $1 order by id`, [meio.c])).map((x) => x.tipo);
  return { ok: !!semMotivo && cv.status === 'encerrada' && cv.motivo_encerramento === 'apenas_informacoes' && cv.encerramento_origem === 'equipe' && !!cv.encerrada_em && fech.n === 1 && ev.includes('encerrada') && ev.includes('assumida'),
    detalhe: `sem motivo: ${semMotivo ? semMotivo.msg.slice(0, 50) : 'ACEITOU'}; eventos: ${ev.join(', ')}` };
});
await caso('paciente escreve depois do encerramento (dentro de 2 dias): a conversa reabre para a equipe', async () => {
  await anonimo();
  const e = await erroDe(() => rpc('chat_enviar', { p_conversa: meio.c, p_token: meio.t, p_texto: 'Esqueci de perguntar uma coisa' }));
  await como('');
  const cv = await conversaDe(meio.c);
  return { ok: e === null && cv.status !== 'encerrada', detalhe: `status=${cv.status}` };
});
await caso('conversa encerrada há mais de 2 dias NÃO reabre por mensagem: o paciente é orientado a abrir uma nova', async () => {
  await como(ATEND);
  await q(`update public.conversas set status = 'em_atendimento', agente_id = $2 where id = $1`, [meio.c, ATEND]);
  await q(`update public.conversas set status = 'encerrada', motivo_encerramento = 'apenas_informacoes' where id = $1`, [meio.c]);
  await como('');
  await db.exec(`alter table public.conversas disable trigger user;`);
  await q(`update public.conversas set encerrada_em = now() - interval '3 days' where id = $1`, [meio.c]);
  await db.exec(`alter table public.conversas enable trigger user;`);
  await anonimo();
  const e = await erroDe(() => rpc('chat_enviar', { p_conversa: meio.c, p_token: meio.t, p_texto: 'Oi de novo' }));
  await como('');
  const cv = await conversaDe(meio.c);
  return { ok: !!e && cv.status === 'encerrada', detalhe: e ? e.msg.slice(0, 90) : 'ACEITOU' };
});

// ---------------------------------------------------------------- 5. o que a equipe enxerga
await caso('a atendente lê as conversas e os pedidos; o cadastro nasce do pedido confirmado; o marketing não lê mensagens nem pedidos', async () => {
  await como(ATEND);
  const a = await um(`select (select count(*)::int from public.conversas) c, (select count(*)::int from public.mensagens) m, (select count(*)::int from public.pre_agendamentos where status = 'pronto') p`);
  await como('');
  const MKT = '00000000-0000-4000-8000-0000000000a3';
  await db.exec(`insert into auth.users (id, email) values ('${MKT}', 'mkt@exemplo.invalid'); insert into public.agentes (id, nome, email, papel, ativo) values ('${MKT}', 'Marketing Teste', 'mkt@exemplo.invalid', 'marketing', true);`);
  await como(MKT);
  const m = await um(`select (select count(*)::int from public.mensagens) m, (select count(*)::int from public.pre_agendamentos) p, (select count(*)::int from public.contatos) ct`);
  await como('');
  return { ok: a.c >= 5 && a.m > 30 && a.p >= 3 && m.m === 0 && m.p === 0 && m.ct > 0, detalhe: `atendente: ${JSON.stringify(a)}; marketing: ${JSON.stringify(m)}` };
});
await caso('rotinas do sistema (código da produção) rodam sobre essas conversas sem erro: espera, encerramento automático, agrupamento, indicadores', async () => {
  const saida = {};
  for (const fn of ['espera_vigiar', 'autoencerrar_vigiar', 'pessoa_agrupar_pendentes', 'agendado_vigiar', 'ind_fechar_pendentes', 'convenios_revisar']) {
    const e = await erroDe(() => q(`select public.${fn}()`));
    saida[fn] = e ? e.msg.slice(0, 80) : 'ok';
  }
  return { ok: Object.values(saida).every((v) => v === 'ok'), detalhe: JSON.stringify(saida) };
});

const passou = resultados.filter(Boolean).length;
console.log(`\n${passou} de ${resultados.length} verificações passaram.`);
process.exit(passou === resultados.length ? 0 : 1);
