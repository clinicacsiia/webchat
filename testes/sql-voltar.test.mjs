// FLUXOGRAMA: entrada (o retrato da produção + supabase/chat-voltar.sql num Postgres embutido) -> validação (o paciente de mentira responde, toca em "Voltar e corrigir" e refaz a resposta) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 12/11/2026 / Mudança: Implementação inicial (botão "Voltar e corrigir" no chat)
// Dados: todos inventados aqui. Nenhuma linha vem da produção.
import { criarBancoProducao, ajudantes } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

import { readFileSync } from 'node:fs';
import { REPO } from './banco-producao.mjs';
const { db } = await criarBancoProducao();
await db.exec(readFileSync(`${REPO}/supabase/chat-voltar.sql`, 'utf8'));
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

const voltar = async (p) => {
  await anonimo();
  const r = await rpc('chat_voltar', { p_conversa: p.c, p_token: p.t });
  const ag = (r.respostas || []).filter((m) => m.autor === 'agente');
  p.ult = ag.at(-1); p.passos.push(p.ult.opcoes.passo || p.ult.opcoes.tipo);
  return r;
};
const escolher = async (p, passo, valor) => {
  const item = p.ult.opcoes.itens.find((x) => x.valor === valor);
  await anonimo();
  const r = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: passo, p_valor: JSON.stringify(valor), p_texto: item.rotulo });
  p.ult = r.respostas.filter((m) => m.autor === 'agente').at(-1); p.passos.push(p.ult.opcoes.passo || p.ult.opcoes.tipo);
};
const pedidoDe = async (c) => { await como(''); return um(`select status, tipo, plano, escolha_horario from public.pre_agendamentos where conversa_id = $1`, [c]); };
const erroDe = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, msg: String(e.message).split('\n')[0] }; } };
const flux = async (c) => { await como(''); return um(`select passo, dados from public.conversa_fluxo where conversa_id = $1`, [c]); };

await caso('voltar do PLANO: refaz a escolha do exame (com o exame antigo trocado) e o resto do caminho continua até o fim', async () => {
  const p = await iniciar('Voltar Plano Teste');
  await responder(p, { motivo: 'exame' }); await responder(p, {});            // motivo, exame
  const antes = p.passos.join(' > ');
  const r = await voltar(p);
  const pa = await pedidoDe(p.c);
  const refeito = await responder(p, {});                                        // escolhe o exame de novo
  const fim = await ateOFim(p, { plano: 'Particular', confirmar: 'ok' });
  const f = await pedidoDe(p.c);
  return { ok: antes === 'motivo > exame > plano' && r.passo === 'exame' && p.passos[3] === 'exame' && /Tudo bem, vamos corrigir/.test(r.respostas.at(-1).texto) && refeito && fim.passos.at(-1) === 'acompanhar' && f.status === 'pronto',
    detalhe: fim.passos.join(' > ') };
});
await caso('voltar do EXAME leva ao MOTIVO e dá para trocar de exame para consulta', async () => {
  const p = await iniciar('Voltar Motivo Teste');
  await responder(p, { motivo: 'exame' });
  const r = await voltar(p);
  await escolher(p, 'motivo', 'consulta');
  const f = await flux(p.c);
  return { ok: r.passo === 'motivo' && p.passos.join(' > ') === 'motivo > exame > motivo > consulta' && f.dados.motivo === 'consulta', detalhe: p.passos.join(' > ') };
});
await caso('voltar do HORÁRIO leva ao PLANO e o plano antigo é apagado', async () => {
  const p = await iniciar('Voltar Horario Teste');
  for (let i = 0; i < 3; i++) await responder(p, { motivo: 'exame', plano: 'Particular' });
  const ok1 = p.ult.opcoes.tipo === 'calendario';
  const r = await voltar(p);
  const pa = await pedidoDe(p.c);
  return { ok: ok1 && r.passo === 'plano' && pa.plano === null, detalhe: p.passos.join(' > ') };
});
await caso('voltar dos DADOS (contato) leva aos dados de identificação, já preenchidos com o que foi digitado', async () => {
  const p = await iniciar('Voltar Dados Teste');
  for (let i = 0; i < 20 && p.ult.opcoes.passo !== 'dados_contato'; i++) await responder(p, { motivo: 'exame', plano: 'Particular' });
  const r = await voltar(p);
  const campos = Object.fromEntries((p.ult.opcoes.campos || []).map((c) => [c.nome, c.valor]));
  return { ok: r.passo === 'dados_ident' && campos.nome === 'Maria Teste da Silva' && !!campos.dt_nasc, detalhe: `${p.passos.join(' > ')} | nome preenchido: ${campos.nome}` };
});
await caso('voltar da CONFIRMAÇÃO leva ao último grupo de dados; voltar de novo segue andando para trás, um passo por vez', async () => {
  const p = await iniciar('Voltar Confirma Teste');
  for (let i = 0; i < 20 && p.ult.opcoes.passo !== 'confirmar'; i++) await responder(p, { motivo: 'exame', plano: 'Particular' });
  const a = await voltar(p), b = await voltar(p), c = await voltar(p), d = await voltar(p);
  return { ok: a.passo === 'dados_contato' && b.passo === 'dados_ident' && c.passo === 'horario' && d.passo === 'plano', detalhe: [a, b, c, d].map((x) => x.passo).join(' < ') };
});
await caso('CONSULTA: voltar do plano leva à escolha do médico; do médico, à consulta', async () => {
  const p = await iniciar('Voltar Consulta Teste');
  await responder(p, { motivo: 'consulta' }); await responder(p, {}); await responder(p, { medico: 'DRA EXEMPLO DOIS' });
  const a = await voltar(p), f = await flux(p.c);
  const b = await voltar(p);
  return { ok: p.passos.slice(0, 4).join(' > ') === 'motivo > consulta > medico > plano' && a.passo === 'medico' && b.passo === 'consulta', detalhe: `${a.passo} / ${b.passo}` };
});
await caso('primeira pergunta: não há o que corrigir antes dela (recusa clara)', async () => {
  const p = await iniciar('Voltar Primeira Teste');
  const e = await erroDe(() => voltar(p));
  return { ok: !!e && e.code === '22023', detalhe: e ? e.msg : 'ACEITOU' };
});
await caso('travas: token errado, token de outra conversa e conversa que a equipe assumiu são recusados', async () => {
  const p = await iniciar('Voltar Trava Teste'), o = await iniciar('Voltar Outro Teste');
  await responder(p, { motivo: 'exame' });
  await anonimo();
  const e1 = await erroDe(() => rpc('chat_voltar', { p_conversa: p.c, p_token: 'errado' }));
  const e2 = await erroDe(() => rpc('chat_voltar', { p_conversa: p.c, p_token: o.t }));
  await como('');
  await db.query(`update public.conversas set ia_ativa = false where id = $1`, [p.c]);
  await anonimo();
  const e3 = await erroDe(() => voltar(p));
  return { ok: e1 && e1.code === '28000' && e2 && e2.code === '28000' && e3 && e3.code === '22023', detalhe: [e1, e2, e3].map((e) => e && e.code).join(',') };
});
await caso('a função auxiliar não pode ser chamada pelo paciente (só pelo banco)', async () => {
  await anonimo();
  const e = await erroDe(() => rpc('fluxo_voltar_passo', { p_conversa: '00000000-0000-4000-8000-000000000001', p_op: 10 }));
  await como('');
  return { ok: !!e && /permission denied/i.test(e.msg), detalhe: e ? e.msg : 'EXECUTOU' };
});

await como('');
const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} passaram`);
process.exit(ok === resultados.length ? 0 : 1);
