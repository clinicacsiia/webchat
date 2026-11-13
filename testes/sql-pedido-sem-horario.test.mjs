// FLUXOGRAMA: entrada (clone da produção + supabase/pedido-sem-horario.sql; pacientes de mentira percorrem o chat até o pedido "pronto", o horário escolhido deixa de valer e a rotina age) -> validação (modo teste só mexe no celular da lista; atendente na conversa = só faixa) -> lógica (oferece o horário mais próximo, depois o seguinte, depois pede que o paciente escolha; "sim" devolve o pedido à equipe com o horário novo) -> saída (mensagens com botões pelas MESMAS funções do chat)
// Versão 1.1 — 13/11/2026 / Mudança: oferta de horário no lugar do cancelamento (pedido do dono, 13/11/2026)
// Dados: todos inventados neste arquivo. Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, separarSql, REPO } from './banco-producao.mjs';

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


// ---------------------------------------------------------------- aplica a mudança ao clone (cron fica de fora)
const sql = readFileSync(`${REPO}/supabase/pedido-sem-horario.sql`, 'utf8');
for (const c of separarSql(sql)) { if (/cron\.schedule/.test(c)) continue; await db.exec(c + ';'); }
const sql2 = readFileSync(`${REPO}/supabase/pedido-previsao.sql`, 'utf8');
for (const c of separarSql(sql2)) { if (/cron\.schedule/.test(c)) continue; await db.exec(c + ';'); }
await db.query(`insert into public.config (chave, valor) values ('pedido_horario_modo', 'teste') on conflict (chave) do update set valor = 'teste'`);

const vigiarPrev = async () => { await como(''); return (await um(`select public.previsao_vigiar() r`)).r; };
const vigiar = async () => { await como(''); return (await um(`select public.pedido_horario_vigiar() r`)).r; };
const lista = async (...tels) => db.query(`insert into public.config (chave, valor) values ('klingo_api_telefones_teste', $1) on conflict (chave) do update set valor = excluded.valor`, [tels.join(',')]);
// pedido pronto com o horário "perdido": volta a data escolhida para 3 dias atrás
const perder = async (p, dias = -3) => {
  await como('');
  await db.query(`update public.pre_agendamentos set escolha_horario = (select jsonb_agg(jsonb_set(e, '{data}', to_jsonb(((now() at time zone 'America/Bahia')::date + $2::int)::text))) from jsonb_array_elements(escolha_horario) e),
    data_desejada = current_date + $2::int where conversa_id = $1`, [p.c, dias]);
};
const ultimaDoAssistente = async (p) => { await como(''); return um(`select texto, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [p.c]); };
const retomar = async (p) => { const m = await ultimaDoAssistente(p); p.ult = { id: (await um(`select max(id) i from public.mensagens where conversa_id = $1`, [p.c])).i, opcoes: m.opcoes, autor: 'agente' }; return m; };
const estado = async (c) => { await como(''); return um(`select c.status, c.ia_ativa, f.passo, f.dados -> 'oferta_pendente' ->> 'n' as n, p.status as ps, p.escolha_horario, p.data_desejada::text as dd, p.hora_desejada as hd, c.alerta_agenda as a
  from public.conversas c join public.conversa_fluxo f on f.conversa_id = c.id join public.pre_agendamentos p on p.conversa_id = c.id where c.id = $1`, [c]); };

const novo = async (nome, tel) => { const p = await ateOFim(await iniciar(nome, tel), { motivo: 'exame', plano: 'Particular', confirmar: 'ok' }); return p; };
const T1 = '71988881001', T2 = '71988881002', T3 = '71988881003', T4 = '71988881004', T5 = '71988881005', FORA = '71977776666', FORA2 = '71977775555';
await lista(T1, T2, T3, T4, T5);

// ---------------------------------------------------------------- 1. recusa duas vezes
let a;
await caso('pedido pronto, horário perdido: o assistente oferece o horário mais PERTO (botões Sim/Não), o pedido sai da fila da equipe e a conversa volta ao assistente', async () => {
  a = await novo('Ana Oferta Teste', T1); await perder(a);
  const r = await vigiar(); const e = await estado(a.c); const m = await retomar(a);
  return { ok: r.ofertas === 1 && e.passo === 'horario_oferta' && e.ia_ativa === true && e.ps === 'rascunho' && e.escolha_horario === null && m.opcoes.passo === 'horario_oferta'
    && m.opcoes.itens.map((x) => x.valor).join() === 'sim,nao' && /não está mais disponível/.test(m.texto) && /Esse horário serve para você\?/.test(m.texto) && !/desculp/i.test(m.texto), detalhe: JSON.stringify(r) + ' | ' + m.texto };
});
await caso('a primeira oferta é um horário livre de hoje em diante (nunca no passado)', async () => {
  const m = await ultimaDoAssistente(a); const mm = /(\d{2})\/(\d{2}) às (\d{2}:\d{2})/.exec(m.texto.split('O mais próximo')[1] || '');
  return { ok: !!mm, detalhe: m.texto };
});
let primeira;
await caso('"Não posso": oferece o PRÓXIMO horário, em outro dia', async () => {
  primeira = (await ultimaDoAssistente(a)).texto.split('O mais próximo que temos é ')[1];
  await responder(a, { horario_oferta: 'nao' });
  const e = await estado(a.c); const m = await ultimaDoAssistente(a);
  const seg = m.texto.split('Temos também ')[1];
  return { ok: e.passo === 'horario_oferta' && e.n === '2' && !!seg && seg.split('.')[0] !== primeira.split('.')[0] && m.opcoes.passo === 'horario_oferta', detalhe: `1ª: ${primeira.split('.')[0]} | 2ª: ${(seg || '').split('.')[0]}` };
});
await caso('recusou de novo: o assistente pergunta o TURNO (filtro da previsão), sem pedir desculpa', async () => {
  await responder(a, { horario_oferta: 'nao' });
  const e = await estado(a.c); const m = await ultimaDoAssistente(a);
  return { ok: e.passo === 'previsao_turno' && e.ps === 'rascunho' && m.opcoes.itens.map((x) => x.valor).join() === 'manha,tarde,qualquer' && !/desculp/i.test(m.texto), detalhe: m.texto };
});
await caso('turno e período: acha horário dentro do filtro e oferece (Sim/Não); recusando 2 vezes pergunta da LISTA DE PREVISÃO com texto claro (NÃO confirma o dia)', async () => {
  await responder(a, { previsao_turno: 'manha' }); const m1 = await ultimaDoAssistente(a);
  await responder(a, { previsao_periodo: 'quinze' }); const m2 = await ultimaDoAssistente(a);
  await responder(a, { horario_oferta: 'nao' }); await responder(a, { horario_oferta: 'nao' });
  const e = await estado(a.c); const m3 = await ultimaDoAssistente(a);
  return { ok: m1.opcoes.passo === 'previsao_periodo' && m2.opcoes.passo === 'horario_oferta' && /dentro do que você pediu/.test(m2.texto) && e.passo === 'previsao_decide'
    && /NÃO confirma o dia do atendimento/.test(m3.texto) && m3.opcoes.itens.map((x) => x.valor).join() === 'lista,calendario', detalhe: m2.texto.slice(0, 90) };
});
await caso('"Prefiro escolher no calendário": o paciente escolhe e o pedido volta pronto para a equipe, com o horário novo', async () => {
  await ateOFim(a, { previsao_decide: 'calendario', confirmar: 'ok' });
  const e = await estado(a.c);
  return { ok: e.ps === 'pronto' && e.ia_ativa === false && Array.isArray(e.escolha_horario) && e.escolha_horario.length === 1 && e.dd >= dia(0), detalhe: JSON.stringify({ ps: e.ps, dd: e.dd }) };
});

// ---------------------------------------------------------------- 2. aceita a primeira
await caso('"Sim, pode ser": o horário oferecido entra no pedido e o pedido volta pronto para a equipe (assistente se despede)', async () => {
  const b = await novo('Bia Aceita Teste', T2); await perder(b);
  await vigiar(); await retomar(b);
  const oferta = (await ultimaDoAssistente(b)).texto.split('O mais próximo que temos é ')[1].split('.')[0];
  await responder(b, { horario_oferta: 'sim' });
  const e = await estado(b.c);
  const dd = e.dd.slice(8, 10) + '/' + e.dd.slice(5, 7);
  return { ok: e.ps === 'pronto' && e.ia_ativa === false && e.escolha_horario.length === 1 && oferta.includes(dd) && oferta.includes(e.hd), detalhe: `${oferta} | gravado ${e.dd} ${e.hd}` };
});

// ---------------------------------------------------------------- 3. regras de segurança
await caso('conversa com atendente: o assistente NÃO oferece nada; só a faixa de aviso para o atendente', async () => {
  const c = await novo('Carla Atendida Teste', T3); await perder(c);
  await como(''); await db.query(`update public.conversas set status = 'em_atendimento' where id = $1`, [c.c]);
  const r = await vigiar(); const e = await estado(c.c);
  return { ok: r.ofertas === 0 && e.ps === 'pronto' && e.passo === 'pronto' && /Pedido sem horário/.test(e.a || ''), detalhe: JSON.stringify(r) };
});
await caso('celular fora da lista nunca é tocado no modo teste; no modo ligado é', async () => {
  const d = await novo('Dora Fora Teste', FORA); await perder(d);
  await vigiar(); const antes = await estado(d.c);
  await como(''); await db.query(`update public.config set valor = 'ligado' where chave = 'pedido_horario_modo'`);
  const r = await vigiar(); const depois = await estado(d.c);
  await db.query(`update public.config set valor = 'teste' where chave = 'pedido_horario_modo'`);
  return { ok: antes.passo === 'pronto' && depois.passo === 'horario_oferta' && r.ofertas >= 1, detalhe: JSON.stringify(r) };
});
await caso('sem nenhum horário livre: pede direto que o paciente escolha (calendário), sem oferta', async () => {
  const e0 = await novo('Eva Sem Agenda Teste', T4); await perder(e0);
  await como(''); await db.exec(`create temp table agenda_guarda as select * from public.catalogo_agenda; delete from public.catalogo_agenda;`);
  const r = await vigiar(); const e = await estado(e0.c); const m = await ultimaDoAssistente(e0);
  await db.exec(`insert into public.catalogo_agenda overriding system value select * from agenda_guarda; drop table agenda_guarda;`);
  return { ok: r.pediu_calendario === 1 && e.passo === 'horario' && m.opcoes.tipo === 'calendario', detalhe: JSON.stringify(r) };
});
await caso('rodar de novo não repete mensagem nem oferta', async () => {
  const antes = (await um(`select count(*)::int n from public.mensagens`)).n;
  const r = await vigiar(); const depois = (await um(`select count(*)::int n from public.mensagens`)).n;
  return { ok: r.ofertas === 0 && r.pediu_calendario === 0 && antes === depois, detalhe: JSON.stringify(r) };
});
await caso('horário livre e pedido parado há 30 h: faixa "Pedido parado", pedido continua pronto e a conferência da agenda não apaga a faixa', async () => {
  const f = await novo('Fabi Parada Teste', T1); 
  await como(''); await db.query(`update public.pre_agendamentos set atualizado_em = now() - interval '30 hours' where conversa_id = $1`, [f.c]);
  await db.query(`insert into public.config (chave, valor) values ('klingo_api_telefones_teste', $1) on conflict (chave) do update set valor = excluded.valor`, [[T1, T2, T3, T4, T5].join(',')]);
  await vigiar(); const e = await estado(f.c);
  const pid = (await um(`select id from public.pre_agendamentos where conversa_id = $1`, [f.c])).id;
  const sl = (await um(`select escolha_horario from public.pre_agendamentos where id = $1`, [pid])).escolha_horario;
  await db.query(`select public.agenda_conferencia_aplicar($1::jsonb)`, [JSON.stringify([{ id: pid, slots: sl.map((_, i) => ({ idx: i, r: 'livre' })) }])]);
  const e2 = await estado(f.c);
  return { ok: e.ps === 'pronto' && /^Pedido parado/.test(e.a || '') && /^Pedido parado/.test(e2.a || ''), detalhe: e2.a };
});
// ---------------------------------------------------------------- 4. lista de previsão
let L;
await caso('"Nenhum horário serve para mim" (celular do modo teste): turno > período > lista de previsão > antecedência, e o pedido chega à equipe SEM horário', async () => {
  L = await ateOFim(await iniciar('Lia Previsao Teste', T5), { motivo: 'exame', plano: 'Particular', horario: 'sem_horario', previsao_turno: 'tarde', previsao_periodo: 'quinze', previsao_decide: 'lista', previsao_antecedencia: '1_semana', confirmar: 'ok' });
  const pa = await pedidoDe(L.c); await como('');
  const prev = await um(`select turno, antecedencia, status from public.pedido_previsao where conversa_id = $1`, [L.c]);
  const nota = await um(`select count(*)::int n from public.mensagens where conversa_id = $1 and texto like '%PREVISÃO (NÃO É AGENDAMENTO)%'`, [L.c]).catch(() => ({ n: -1 }));
  const nota2 = (await um(`select dados::text t from public.conversa_fluxo where conversa_id = $1`, [L.c])).t;
  const i = (n) => L.passos.indexOf(n);
  return { ok: i('previsao_turno') > i('horario') && i('previsao_periodo') > i('previsao_turno') && i('previsao_decide') > i('previsao_periodo') && i('previsao_antecedencia') > i('previsao_decide')
    && pa.status === 'pronto' && pa.horarios === 0 && prev.turno === 'tarde' && prev.antecedencia === '1_semana' && prev.status === 'aguardando' && /PREVISÃO \(NÃO É AGENDAMENTO\)/.test(nota2),
    detalhe: L.passos.join(' > ') };
});
await caso('o texto final repete que a previsão NÃO confirma o dia do atendimento', async () => {
  await como(''); const t = (await q(`select texto from public.mensagens where conversa_id = $1 and autor = 'agente' and texto like 'Anotado!%'`, [L.c]));
  return { ok: t.length === 1 && /NÃO confirma o dia do atendimento/.test(t[0].texto) };
});
await caso('celular fora do modo teste: "Nenhum horário serve" continua como sempre (sem filtro, sem lista)', async () => {
  const x = await ateOFim(await iniciar('Fora Do Teste', FORA2), { motivo: 'exame', plano: 'Particular', horario: 'sem_horario', confirmar: 'ok' });
  return { ok: !x.passos.some((n) => String(n).startsWith('previsao_')) && x.passos.at(-1) === 'acompanhar', detalhe: x.passos.join(' > ') };
});
await caso('abre vaga à tarde dentro da previsão: a ATENDENTE recebe a faixa "Vaga aberta" (nada é marcado sozinho)', async () => {
  await como('');
  await db.exec(`create temp table agenda_tarde as select procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, '14:00'::text hora_ini, '17:00'::text hora_fim, duracao_min, vig_ini, vig_fim from public.catalogo_agenda where procedimento_id = 201;`);
  const antes = (await vigiarPrev()); 
  await db.exec(`insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim) select * from agenda_tarde;`);
  const r = await vigiarPrev(); const e = await estado(L.c); const pv = await um(`select status from public.pedido_previsao where conversa_id = $1`, [L.c]);
  return { ok: antes.vagas_novas === 0 && r.vagas_novas >= 1 && pv.status === 'vaga_encontrada' && /^Vaga aberta dentro da previsão/.test(e.a || '') && e.ps === 'pronto' && e.escolha_horario === null, detalhe: e.a };
});
await caso('a vaga some: a faixa sai e o paciente volta a "aguardando"; pedido agendado sai da lista', async () => {
  await como(''); await db.exec(`delete from public.catalogo_agenda where hora_ini = '14:00';`);
  const r = await vigiarPrev(); const e = await estado(L.c); const pv = await um(`select status from public.pedido_previsao where conversa_id = $1`, [L.c]);
  await db.query(`update public.pre_agendamentos set status = 'agendado' where conversa_id = $1`, [L.c]);
  const r2 = await vigiarPrev(); const pv2 = await um(`select status from public.pedido_previsao where conversa_id = $1`, [L.c]);
  return { ok: r.vagas_que_sumiram === 1 && pv.status === 'aguardando' && !e.a && pv2.status === 'atendida' && r2.encerradas_da_lista === 1, detalhe: JSON.stringify([r, r2]) };
});
await caso('só o sistema executa a rotina (anon e authenticated não)', async () => {
  const x = await um(`select has_function_privilege('anon','public.pedido_horario_vigiar()','execute') a, has_function_privilege('authenticated','public.pedido_horario_vigiar()','execute') b, has_function_privilege('service_role','public.pedido_horario_vigiar()','execute') c`);
  return { ok: !x.a && !x.b && x.c };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
