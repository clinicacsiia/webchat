// FLUXOGRAMA (dados já salvos não são perguntados de novo; parte do sql-ponta-a-ponta): entrada (o retrato da produção montado num Postgres embutido + um catálogo inventado) -> validação (um "paciente" de mentira percorre o chat pelas MESMAS funções que o index.html chama, como papel anon; uma "atendente" de mentira assume, responde e encerra como papel authenticated) -> lógica (confere em cada passo o que o assistente pergunta, o que fica gravado e o que cada papel consegue ou não ver) -> saída (PASS/FAIL por verificação; código de saída 1 se algo falhar)
// Versão 1.0 — 11/11/2026 / Mudança: Implementação inicial (auditoria de 11/11/2026)
//
// É o teste que prova "do Começar ao pedido enviado" com o CÓDIGO REAL do banco de produção (supabase/producao/), não com cópias antigas.
// Dados: todos inventados aqui. Nenhuma linha vem da produção.
// O que NÃO prova: a tela (isso é dos testes *.navegador.mjs), o Klingo, o push e o tempo real por WebSocket.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(readFileSync(`${REPO}/supabase/dados-ja-salvos-nao-perguntar.sql`, 'utf8'));   // a mudança em teste, por cima do retrato

const ADMIN = '00000000-0000-4000-8000-0000000000a1', ATEND = '00000000-0000-4000-8000-0000000000a2', OUTRO_PACIENTE = '00000000-0000-4000-8000-0000000000b1';
const UNIDADE = 'CLÍNICA DE SAÚDE E IMAGEM - CSI';
await db.exec(`
  insert into auth.users (id, email) values ('${ADMIN}', 'admin@exemplo.invalid'), ('${ATEND}', 'atendente@exemplo.invalid'), ('${OUTRO_PACIENTE}', 'paciente@exemplo.invalid');
  insert into public.agentes (id, nome, email, papel, ativo) values ('${ADMIN}', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true), ('${ATEND}', 'Ana Atendente', 'atendente@exemplo.invalid', 'atendente', true);
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!'), ('reabrir_dias', '2')
    on conflict (chave) do update set valor = excluded.valor;
  -- 19/11/2026: a consulta de adulto só segue em unidade autorizada (supabase/unidade-so-desenvoar-whatsapp.sql); o clone precisa de uma unidade ativa de adulto
  insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao, ordem, ativo) values ('csi', '${UNIDADE}', 'CSI', 'x', 'exame_consulta', 'x', 1, true) on conflict (chave) do update set ativo = true, catalogo = excluded.catalogo, fluxo = excluded.fluxo;
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


let p1;
await caso('CONTATO JÁ SALVO (celular e e-mail do formulário inicial): o chat NÃO pergunta o contato de novo; grava no pedido; só falta o sexo (não salvo) e a confirmação final', async () => {
  p1 = await ateOFim(await iniciar('Maria Teste da Silva', '71987000123'), { motivo: 'exame', plano: 'Particular', confirmar: 'ok' });
  const pa = await pedidoDe(p1.c);
  return { ok: !p1.passos.includes('dados_contato') && p1.passos.includes('dados_ident') && p1.passos.includes('confirmar') && pa.status === 'pronto'
    && pa.paciente.celular === '71987000123' && pa.paciente.email === 'maria@exemplo.invalid', detalhe: p1.passos.join(' > ') };
});
await caso('NOME E SEXO JÁ SALVOS no pedido: nenhum dos dois passos de dados é perguntado', async () => {
  const p = await iniciar('Joana Teste Lima', '71987000124');
  await como('');
  await q(`select public.fluxo_pre($1, '{"paciente": {"nome": "Joana Teste Lima", "sexo": "F"}}'::jsonb)`, [p.c]);
  await anonimo();
  await ateOFim(p, { motivo: 'exame', plano: 'Particular', confirmar: 'ok' });
  return { ok: !p.passos.includes('dados_ident') && !p.passos.includes('dados_contato') && p.passos.includes('confirmar'), detalhe: p.passos.join(' > ') };
});
await caso('E-MAIL NÃO SALVO (só o celular): o contato continua sendo perguntado (só pula o que está certo)', async () => {
  const p0 = await iniciar('Pedro Teste Souza', '71987000125'); await como(''); await q(`update public.conversas set email_informado = null where id = $1`, [p0.c]); await q(`update public.contatos set email = null where id = (select contato_id from public.conversas where id = $1)`, [p0.c]); await anonimo();
  const p = await ateOFim(p0, { motivo: 'exame', plano: 'Particular', confirmar: 'ok' });
  return { ok: p.passos.includes('dados_contato'), detalhe: p.passos.join(' > ') };
});

const passou = resultados.filter(Boolean).length;
console.log(`\n${passou} de ${resultados.length} verificações passaram.`);
process.exit(passou === resultados.length ? 0 : 1);
