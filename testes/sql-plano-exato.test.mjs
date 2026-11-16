// FLUXOGRAMA: entrada (retrato da produção + supabase/plano-exato.sql aplicado + planos inventados) -> validação (paciente de mentira percorre o chat pelas mesmas funções do index.html)
//   -> saída (o passo 'plano_exato' aparece só para convênio sem plano padrão; a escolha vira "OPERADORA#id" no klingo_dados_conversa e o klingo_plano_resolver devolve esse plano; interruptor, troca de convênio e "não sei" tratados).
// Versão 1.0 — 16/11/2026 / Mudança: primeira versão (plano exato para Bradesco, SulAmérica e outros convênios com muitos planos).
// Dados: todos inventados aqui.
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
  if (!o || o.tipo === 'acompanhar' || o.tipo === 'marcando') return false;   // 'marcando' = a marcação automática assume (fora deste teste)
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
    await semearOfertas(p.c);
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

// Desde 14/11/2026 o calendário só mostra horário que a API do Klingo ofereceu (tabela klingo_oferta + consulta registrada).
// Aqui o teste faz o papel da Edge Function chat-agenda-api: grava as ofertas da conversa e a consulta que as originou.
const semearOfertas = async (conversa) => {
  await como('');
  const it = await um(`select i.procedimento_id id, c.medico_preferido medico from public.pre_agendamento_itens i join public.conversas c on c.id = i.conversa_id where i.conversa_id = $1 and i.ativo and i.procedimento_id is not null order by i.id limit 1`, [conversa]);
  if (!it) throw new Error('sem exame/consulta no pedido para semear horários');
  const lista = [1, 2, 3].flatMap((n) => ['08:30', '10:00'].map((h) => ({ chave: `${dia(n)}|63|308|2|${h}`, data: dia(n), hora: h, profissional: it.medico || 'DRA EXEMPLO IMAGEM', unidade: UNIDADE })));
  await db.query(`select public.klingo_oferta_gravar_v2($1, $2, 1, $3::jsonb, false, true)`, [conversa, it.id, JSON.stringify(lista)]);
  await db.query(`select public.klingo_consulta_registrar($1, 'sim', 'exame', $2, 1, 'ok_com_horarios', 200, 6, 6, 0, 6, 900, null)`, [conversa, it.id]);
  await anonimo();
};
const pedidoDe = (c) => um(`select status, etapa, tipo, plano, procedimento, profissional, jsonb_array_length(coalesce(escolha_horario, '[]'::jsonb))::int as horarios, paciente from public.pre_agendamentos where conversa_id = $1`, [c]);
const conversaDe = (c) => um(`select status, ia_ativa, agente_id, motivo_encerramento, encerramento_origem, primeiro_humano_em, encerrada_em from public.conversas where id = $1`, [c]);
const erroDe = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, msg: String(e.message).split('\n')[0] }; } };


import { readFileSync } from 'node:fs';
import { REPO as RAIZ, separarSql } from './banco-producao.mjs';
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste'), ('klingo_interno_segredo', 'segredo-de-teste') on conflict (name) do nothing`);
await como('');
for (const cmd of separarSql(readFileSync(`${RAIZ}/supabase/plano-exato.sql`, 'utf8'))) await db.exec(cmd);
await db.exec(`
  insert into public.catalogo_plano (operadora, plano, produto, busca, ativo) values
    ('BRADESCO SAUDE', 'BRADESCO SAUDE EMPRESA', 'x', '', true), ('HAPVIDA', 'HAPVIDA', 'x', '', true), ('Particular', 'PARTICULAR', 'x', '', true);
  insert into public.klingo_plano_map (operadora, origem, plano_id, convenio_id) values
    ('BRADESCO SAUDE', 'auto', null, 12), ('HAPVIDA', 'auto', 22, 17), ('Particular', 'auto', 1, 1)
    on conflict (operadora) do update set origem = excluded.origem, plano_id = excluded.plano_id, convenio_id = excluded.convenio_id;
  insert into public.klingo_convenio (plano_id, convenio_id, convenio, plano, convenio_norm, padrao) values
    (457, 12, 'BRADESCO SAUDE', 'BRADESCO SAUDE EMPRESA', 'BRADESCO SAUDE', false), (458, 12, 'BRADESCO SAUDE', 'EFETIVO', 'BRADESCO SAUDE', false),
    (520, 12, 'BRADESCO SAUDE', 'XEROX DO BRASIL', 'BRADESCO SAUDE', false),
    (521, 12, 'BRADESCO SAUDE', 'BRADESCO SAUDE INDIVIDUAL', 'BRADESCO SAUDE', false), (522, 12, 'BRADESCO SAUDE', 'EFETIVO', 'BRADESCO SAUDE', false),
    (22, 17, 'HAPVIDA', 'HAPVIDA', 'HAPVIDA', true), (23, 17, 'HAPVIDA', 'HAP4', 'HAPVIDA', false), (1, 1, 'PARTICULAR', 'PARTICULAR', 'PARTICULAR', true);
`);
const cfg = (k, v) => db.exec(`insert into public.config (chave, valor) values ('${k}', '${v}') on conflict (chave) do update set valor = excluded.valor`);
const nota = async (c) => { await como(''); return um(`select dados from public.conversa_fluxo where conversa_id = $1`, [c]); };
const res = async (op, cad = null) => (await como(''), await q(`select public.klingo_plano_resolver($1, $2) r`, [op, cad]))[0].r;

await caso('Convênio SEM plano padrão (Bradesco): depois do convênio vem o passo plano_exato, com "Não sei" + os planos reais e etiqueta nos nomes repetidos', async () => {
  const p = await iniciar('Plano Exato Teste');
  let i = 0; while (p.ult.opcoes?.passo !== 'plano_exato' && i++ < 12) await responder(p, { motivo: 'consulta', plano: 'BRADESCO SAUDE' });
  const it = p.ult.opcoes.itens, rot = Object.fromEntries(it.map((x) => [x.valor, x.rotulo]));
  const ok = p.ult.opcoes.passo === 'plano_exato' && it[0].valor === 'nao_sei' && rot['458'] === 'EFETIVO (Empresarial)' && rot['522'] === 'EFETIVO (Individual)'
    && rot['520'] === 'XEROX DO BRASIL' && rot['457'] === 'BRADESCO SAUDE EMPRESA' && it.length === 6 && /Bradesco Saude/.test(p.ult.texto);
  return { ok, detalhe: JSON.stringify(rot) + ' | ' + p.passos.join(' > ') };
});
await caso('Escolher o plano exato: grava a escolha, vira OPERADORA#id para a API, o resolver devolve o plano escolhido e a equipe recebe a nota', async () => {
  const p = await ateOFim(await iniciar('Plano Escolhido Teste'), { motivo: 'consulta', plano: 'BRADESCO SAUDE', plano_exato: '522', confirmar: 'ok' });
  const f = await nota(p.c), d = (await q(`select public.klingo_dados_conversa($1) d`, [p.c]))[0].d;
  const r = await res(d.plano, 999), semEscolha = await res('BRADESCO SAUDE', null), lei = (await q(`select public.fluxo_leitura($1) t`, [p.c]))[0].t;
  const ok = p.passos.join(' > ').includes('plano > plano_exato > horario') && f.dados.plano_exato_id === 522 && d.plano === 'BRADESCO SAUDE#522' && r.plano_id === 522 && r.via === 'escolhido'
    && semEscolha.plano_id === null && semEscolha.motivo === 'plano_do_cadastro_necessario' && (f.dados.notas || []).some((n) => /Plano escolhido pelo paciente: EFETIVO \(Individual\)/.test(n)) && /Plano: Bradesco Saude — EFETIVO \(Individual\)/.test(lei);
  return { ok, detalhe: `${p.passos.join(' > ')} | chave=${d.plano} | resolver=${JSON.stringify(r)}` };
});
await caso('O resolver ignora id de OUTRO convênio e usa o resto da regra (cadastro / sem plano)', async () => {
  const a = await res('BRADESCO SAUDE#22', null), b = await res('BRADESCO SAUDE#22', 458), c = await res('HAPVIDA#22', null);
  return { ok: a.plano_id === null && b.plano_id === 458 && b.via === 'cadastro' && c.plano_id === 22 && c.via === 'escolhido', detalhe: JSON.stringify([a, b, c]) };
});
await caso('Escolha inválida (id de outro convênio ou lixo) é recusada e não grava nada', async () => {
  const p = await iniciar('Plano Invalido Teste'); let i = 0;
  while (p.ult.opcoes?.passo !== 'plano_exato' && i++ < 12) await responder(p, { motivo: 'consulta', plano: 'BRADESCO SAUDE' });
  await anonimo();
  const r1 = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: 'plano_exato', p_valor: JSON.stringify('22'), p_texto: 'x' });
  const r2 = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: 'plano_exato', p_valor: JSON.stringify('abc'), p_texto: 'x' });
  await como(''); const f = await nota(p.c);
  return { ok: f.dados.plano_exato_id == null && JSON.stringify(r1).includes('Não achei esse plano') , detalhe: JSON.stringify(r1).slice(0, 200) + ' | ' + JSON.stringify(r2).slice(0, 120) };
});
await caso('"Não sei qual é o meu plano": segue o pedido, deixa nota para a equipe e NÃO manda plano para o Klingo', async () => {
  const p = await ateOFim(await iniciar('Nao Sei Teste'), { motivo: 'consulta', plano: 'BRADESCO SAUDE', plano_exato: 'nao_sei', confirmar: 'ok' });
  const f = await nota(p.c), d = (await q(`select public.klingo_dados_conversa($1) d`, [p.c]))[0].d;
  return { ok: f.dados.plano_exato_id === 0 && d.plano === 'BRADESCO SAUDE' && (f.dados.notas || []).some((n) => /não soube o plano exato/.test(n)) && ['acompanhar', 'marcando'].includes(p.passos.at(-1)), detalhe: p.passos.join(' > ') };
});
await caso('Convênio com plano padrão (Hapvida) e Particular NÃO ganham passo novo', async () => {
  const h = await ateOFim(await iniciar('Hapvida Teste'), { motivo: 'consulta', plano: 'HAPVIDA', confirmar: 'ok' });
  const pa = await ateOFim(await iniciar('Particular Teste'), { motivo: 'consulta', plano: 'Particular', confirmar: 'ok' });
  return { ok: !h.passos.includes('plano_exato') && !pa.passos.includes('plano_exato'), detalhe: h.passos.join(' > ') };
});
await caso('Interruptor plano_exato_modo = nao: volta ao comportamento antigo (sem passo, resolver como antes)', async () => {
  await cfg('plano_exato_modo', 'nao');
  let p; try { p = await ateOFim(await iniciar('Desligado Teste'), { motivo: 'consulta', plano: 'BRADESCO SAUDE', confirmar: 'ok' }); } finally { await cfg('plano_exato_modo', 'sim'); }
  return { ok: !p.passos.includes('plano_exato'), detalhe: p.passos.join(' > ') };
});
await caso('Corrigir o plano na confirmação apaga a escolha antiga; trocar para Hapvida não leva o plano do Bradesco junto', async () => {
  const p = await iniciar('Troca Teste'); let i = 0;
  while (p.ult.opcoes?.passo !== 'confirmar' && i++ < 30 && await responder(p, { motivo: 'consulta', plano: 'BRADESCO SAUDE', plano_exato: '458' }));
  const antes = (await nota(p.c)).dados.plano_exato_id;
  await responder(p, { confirmar: 'plano' });   // "Corrigir o plano"
  const meio = (await nota(p.c)).dados.plano_exato_id;
  await responder(p, { plano: 'HAPVIDA' });
  const depois = await nota(p.c), d = (await q(`select public.klingo_dados_conversa($1) d`, [p.c]))[0].d;
  return { ok: antes === 458 && (meio == null) && depois.dados.plano_exato_id == null && d.plano === 'HAPVIDA', detalhe: `antes=${antes} meio=${meio} depois=${depois.dados.plano_exato_id} chave=${d.plano} | ${p.passos.join(' > ')}` };
});
await como('');
const falhas = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhas} de ${resultados.length} passaram`);
process.exit(falhas ? 1 : 0);
