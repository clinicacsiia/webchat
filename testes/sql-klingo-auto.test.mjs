// FLUXOGRAMA: entrada (o retrato da produção + as partes 1 a 4 de supabase/klingo-auto-*.sql montados num Postgres embutido) -> validação (um "paciente" de mentira percorre o chat pelas funções que o index.html chama;
//   o Klingo é de mentira: o teste faz o papel do executor chamando klingo_operacao_pegar/concluir) -> lógica (confere o passo novo CPF+nascimento, a automação ligada e desligada, duplo toque, horário tomado,
//   resultado incerto, cota, tradução de convênio, identidade só com hash e as travas de acesso) -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 12/11/2026 / Mudança: primeira versão (autoatendimento com a API do Klingo).
// Dados: todos inventados aqui. Nenhuma linha vem da produção e nada é enviado ao Klingo de verdade.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste'), ('klingo_interno_segredo', 'interno-de-teste')`);
for (const f of ['klingo-auto-parte1-tabelas', 'klingo-auto-parte2-base', 'klingo-auto-parte3-identidade', 'klingo-auto-parte4a-operacao', 'klingo-auto-parte4b-motor', 'klingo-auto-parte5-autogestao', 'klingo-auto-parte6-novo-e-eventos', 'klingo-auto-parte7-indicadores', 'klingo-auto-parte8-pos-marcacao', 'klingo-auto-parte9-voltar', 'klingo-auto-parte10-interruptor-geral', 'klingo-auto-parte11-voltar-mae-divergencia', 'klingo-auto-parte12-convenio-segue-klingo', 'klingo-auto-parte13-paciente-conhecido-cpf', 'klingo-auto-parte14-quadros-encerrar-agendado', 'klingo-auto-parte15-so-o-que-o-klingo-libera']) {
  try { await db.exec(readFileSync(`${REPO}/supabase/${f}.sql`, 'utf8')); } catch (e) { registrar(`aplicar ${f}.sql no clone da produção`, false, String(e.message).split('\n')[0]); }
}
await db.exec(`insert into public.config (chave, valor) values ('klingo_auto', 'legado') on conflict (chave) do update set valor = 'legado'`);   // os casos abaixo testam as regras por chave; o interruptor geral tem casos próprios no fim
registrar('o retrato da produção monta inteiro e as 16 partes novas aplicam sem erro', falhas.length === 0 && resultados.every(Boolean));

const UNIDADE = 'CLÍNICA DE SAÚDE E IMAGEM - CSI';
await db.exec(`
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
  insert into public.klingo_plano_map (operadora, convenio_id, plano_id, origem) values ('Particular', 1, 1, 'auto'), ('Amil', 9, 14, 'auto'), ('Sulamerica', 5, null, 'auto'), ('Convenio Fantasma', null, null, 'nao_atende');
  insert into public.klingo_convenio (plano_id, convenio_id, convenio, plano, convenio_norm, padrao) values (1, 1, 'Particular', 'PARTICULAR', 'PARTICULAR', true), (8, 1, 'Particular', 'CORTESIA', 'PARTICULAR', false),
    (14, 9, 'AMIL', 'AMIL', 'AMIL', true), (700, 5, 'SULAMERICA', 'SULAMERICA PLANO X', 'SULAMERICA', false);
`);

// ---------------------------------------------------------------- o paciente de mentira
const CAMPO = (c) => (c.tipo === 'sexo' ? 'F' : c.tipo === 'data' ? '25/03/1980' : c.tipo === 'cpf' ? '111.444.777-35' : c.tipo === 'tel' ? '(71) 99999-0001' : c.tipo === 'email' ? 'maria@exemplo.invalid'
  : c.tipo === 'cep' ? '40000-000' : c.tipo === 'uf' ? 'BA' : c.nome === 'nome' ? 'Maria Teste da Silva' : c.nome === 'mae' ? 'Ana Teste da Silva' : c.nome === 'numero' ? '10' : 'Texto de teste');
let nTel = 0;
const telefone = () => '7198' + String(5000000 + ++nTel);
const rpc = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  const r = await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k])));
  return r[0].r;
};
async function iniciar(nome = 'Maria Teste da Silva', tel = telefone()) {
  await anonimo();
  const r = await rpc('chat_iniciar', { p_nome: nome, p_telefone: tel, p_email: 'maria@exemplo.invalid', p_aceite: true, p_paciente_tipo: 'proprio' });
  return { c: r.conversa_id, t: r.token, tel, ult: r.respostas.at(-1), passos: [r.respostas.at(-1).opcoes.passo], campos: {} };
}
async function responder(p, escolhas = {}) {
  const o = p.ult.opcoes; let r;
  if (!o || o.tipo === 'acompanhar' || o.tipo === 'marcando' || o.tipo === 'nova') return false;
  await anonimo();
  if (o.tipo === 'escolha') {
    const quer = escolhas[o.passo];
    const item = (o.itens || []).find((x) => x.valor === quer) || (quer === undefined ? (o.itens || [])[0] : null);
    if (!item) throw new Error(`passo ${o.passo}: opção ${JSON.stringify(quer)} não oferecida (${(o.itens || []).map((x) => x.valor).join(', ')})`);
    r = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify(item.valor), p_texto: item.rotulo });
  } else if (o.tipo === 'campos') {
    p.campos[o.passo] = o.campos;
    const v = {}; for (const cp of o.campos || []) v[cp.nome] = (escolhas.campos && escolhas.campos[o.passo] && escolhas.campos[o.passo][cp.nome]) ?? CAMPO(cp);
    r = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: v, p_texto: null });
  } else if (o.tipo === 'pedido_consulta') {
    const cs = await rpc('chat_consultas', { p_conversa: p.c, p_token: p.t });
    r = await rpc('chat_consulta_salvar', { p_conversa: p.c, p_token: p.t, p_procedimento_id: cs.consultas[0].id });
  } else if (o.tipo === 'busca_exame' || o.tipo === 'pedido_exames') {
    const ex = await rpc('chat_exames', { p_conversa: p.c, p_token: p.t, p_modalidade: 'RM', p_regiao: 'joelho' });
    r = await rpc('chat_pedido_enviar', { p_conversa: p.c, p_token: p.t, p_itens: [{ modalidade: 'RM', regiao: 'joelho', lado: 'D', procedimento_id: ex[0].id }] });
  } else if (o.tipo === 'calendario') {
    if (escolhas.antesDoHorario) await escolhas.antesDoHorario(p);
    const hs = await rpc('chat_horarios', { p_conversa: p.c, p_token: p.t, p_grupo: o.grupo || 1, p_de: dia(0), p_ate: dia(20) });
    p.horarios = hs;
    const d = hs.dias[0], s = d.slots[0];
    p.escolhido = { data: d.data, hora: s.hora, unidade: s.unidade, profissional: s.profissional };
    r = await rpc('chat_horario_escolher', { p_conversa: p.c, p_token: p.t, p_grupo: o.grupo || 1, p_data: d.data, p_hora: s.hora, p_unidade: s.unidade });
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
const pedidoDe = (c) => um(`select status, etapa, tipo, plano, escolha_horario, agendado_origem, klingo_marcacoes, klingo_paciente_id, paciente from public.pre_agendamentos where conversa_id = $1`, [c]);
const conversaDe = (c) => um(`select status, ia_ativa, motivo_encerramento, encerramento_origem, primeiro_humano_em, triagem_resumo from public.conversas where id = $1`, [c]);
const fluxoDe = (c) => um(`select passo, dados from public.conversa_fluxo where conversa_id = $1`, [c]);
const erroDe = async (fn) => { try { await fn(); return null; } catch (e) { return { code: e.code, msg: String(e.message).split('\n')[0] }; } };
const garantirPedido = (c) => db.query(`insert into public.pre_agendamentos (conversa_id) values ($1) on conflict (conversa_id) do nothing`, [c]);
const cfg = async (k, v) => { await db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [k, v]); };
// Oferta de mentira da API para uma conversa: o horário que a grade mostraria primeiro, com o nome do médico escrito do jeito da API (sem "DR").
const ofertar = async (p, { extra = [] } = {}) => {
  const hs = await rpc('chat_horarios', { p_conversa: p.c, p_token: p.t, p_grupo: 1, p_de: dia(0), p_ate: dia(20) });
  const d = hs.dias[0], s = d.slots[0];
  const lista = [{ chave: `${d.data}|63|308|2|${s.hora}`, data: d.data, hora: s.hora, profissional: String(s.profissional).replace(/^DRA? /, '') + ' SILVA', unidade: s.unidade, unidade_id: '2' }, ...extra];
  await como('');
  await db.query(`select public.klingo_oferta_gravar($1::uuid, 201, 1, $2::jsonb)`, [p.c, JSON.stringify(lista)]);
  return lista[0];
};

// ---------------------------------------------------------------- 1. o passo novo (CPF + nascimento obrigatórios), com a automação desligada
let base;
await caso('CPF e nascimento viram passo obrigatório (antes do plano); com a automação desligada o pedido chega à equipe como sempre', async () => {
  base = await ateOFim(await iniciar(), { motivo: 'exame', plano: 'Particular', confirmar: 'ok' });
  const pa = await pedidoDe(base.c), cv = await conversaDe(base.c);
  const esperado = 'motivo > exame > cpf_nasc > plano > horario > dados_ident > dados_contato > confirmar > acompanhar';
  const camposCpf = base.campos.cpf_nasc || [], obrig = (n) => (camposCpf.find((c) => c.nome === n) || {}).obrigatorio;
  const cpfIdent = (base.campos.dados_ident || []).find((c) => c.nome === 'cpf');
  return { ok: base.passos.join(' > ') === esperado && pa.status === 'pronto' && obrig('cpf') === true && obrig('dt_nasc') === true && cpfIdent && cpfIdent.obrigatorio === true
    && pa.paciente.cpf === '11144477735' && pa.paciente.dt_nasc === '1980-03-25' && cv.ia_ativa === false && pa.agendado_origem === null, detalhe: base.passos.join(' > ') };
});
await caso('CPF inválido ou data impossível no passo novo: o chat recusa e pergunta de novo, sem avançar', async () => {
  const p = await iniciar('Cpf Errado Teste');
  for (let i = 0; i < 6 && p.ult.opcoes.passo !== 'cpf_nasc'; i++) await responder(p, { motivo: 'exame' });
  await anonimo();
  const r = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: 'cpf_nasc', p_valor: { cpf: '111.111.111-11', dt_nasc: '31/02/1980' }, p_texto: null });
  const ult = r.respostas.filter((m) => m.autor === 'agente').at(-1);
  await como('');
  const f = await fluxoDe(p.c);
  return { ok: /CPF/.test(ult.texto) && /nascimento/.test(ult.texto) && ult.opcoes && ult.opcoes.passo === 'cpf_nasc' && f.passo === 'cpf_nasc', detalhe: ult.texto.slice(0, 90) };
});
await caso('quem volta SEM CPF no cadastro é perguntado de novo (a "pessoa conhecida" não pula mais o CPF)', async () => {
  const p = await iniciar('Sem Cpf Conhecida'); await como(''); await garantirPedido(p.c);
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento) values ($1, 'RM', 'JOELHO', 'Joelho', 'D', 201, 'RM JOELHO')`, [p.c]);
  await db.query(`update public.pre_agendamentos set tipo = 'exame', plano = 'Particular', identidade = 'conferida', paciente = '{"nome":"Sem Cpf Conhecida","sexo":"F","dt_nasc":"1980-03-25","celular":"71999990001"}'::jsonb where conversa_id = $1`, [p.c]);
  await db.query(`update public.conversa_fluxo set dados = dados || '{"identidade_feita": true, "atalho_feito": true, "motivo": "exame", "sem_horario": true}'::jsonb where conversa_id = $1`, [p.c]);
  const sem = await um(`select public.fluxo_proximo($1) p`, [p.c]);
  await db.query(`update public.pre_agendamentos set paciente = paciente || '{"cpf":"11144477735"}'::jsonb where conversa_id = $1`, [p.c]);
  const com = await um(`select public.fluxo_proximo($1) p`, [p.c]);
  return { ok: sem.p === 'cpf_nasc' && com.p === 'confirmar', detalhe: `sem CPF: ${sem.p}; com CPF (cadastro completo): ${com.p}` };
});

// ---------------------------------------------------------------- 2. conferência de identidade (só hash) e revisão dos antigos
await caso('ao informar CPF + nascimento o banco pede a conferência à API (chamada só com o segredo do cofre, uma vez por par)', async () => {
  const ch = await q(`select url, body, headers from net.chamadas where url like '%klingo-identificar' and body ->> 'conversa' = $1`, [base.c]);
  return { ok: ch.length === 1 && ch[0].body.cpf === '11144477735' && ch[0].body.nascimento === '1980-03-25' && ch[0].headers['x-klingo-segredo'] === 'interno-de-teste' && !('x-sync-key' in ch[0].headers), detalhe: `${ch.length} chamada(s)` };
});
await caso('o resultado da API grava só HASH (nenhum CPF em claro), liga o pedido ao cadastro e avisa a equipe uma vez', async () => {
  const r = await rpc('klingo_identidade_registrar', { p_cpf: '11144477735', p_nasc: '1980-03-25', p_r: { situacao: 'confere', klingo_id: 'P555', faltando: ['email'], plano_id: 14 }, p_conversa: base.c });
  await rpc('klingo_identidade_registrar', { p_cpf: '11144477735', p_nasc: '1980-03-25', p_r: { situacao: 'confere', klingo_id: 'P555', faltando: ['email'], plano_id: 14 }, p_conversa: base.c });
  const i = await um(`select * from public.klingo_identidade`), pa = await pedidoDe(base.c), f = await fluxoDe(base.c);
  const claro = JSON.stringify(i).includes('11144477735') || JSON.stringify(i).includes('1980-03-25');
  const notas = (f.dados.notas || []).filter((n) => /Klingo \(API\)/.test(n)).length;
  return { ok: r.situacao === 'confere' && i.tipo === 'definitivo' && i.klingo_id === 'P555' && !claro && i.cpf_hash.length === 64 && pa.klingo_paciente_id === 'P555' && notas === 1, detalhe: `hash=${i.cpf_hash.slice(0, 8)}…; notas da API: ${notas}` };
});
await caso('o id definitivo só aceita "P"+número e o pré-cadastro só número (a regra que evita abrir a sessão de outra pessoa)', async () => {
  const e1 = await erroDe(() => db.query(`insert into public.klingo_identidade (chave, cpf_hash, tipo, klingo_id, situacao) values ('a','b','definitivo','123','confere')`));
  const e2 = await erroDe(() => db.query(`insert into public.klingo_identidade (chave, cpf_hash, tipo, klingo_id, situacao) values ('c','d','pre','P123','pre_cadastro')`));
  await db.query(`insert into public.klingo_identidade (chave, cpf_hash, tipo, klingo_id, situacao) values ('e','dup','pre','900','pre_cadastro')`);
  const e3 = await erroDe(() => db.query(`insert into public.klingo_identidade (chave, cpf_hash, tipo, klingo_id, situacao) values ('f','dup','pre','901','pre_cadastro')`));
  await db.query(`delete from public.klingo_identidade where chave = 'e'`);
  return { ok: !!e1 && !!e2 && !!e3, detalhe: `P sem P: ${e1 ? 'recusado' : 'ACEITOU'}; pré com P: ${e2 ? 'recusado' : 'ACEITOU'}; 2º pré-cadastro do mesmo CPF: ${e3 ? 'recusado' : 'ACEITOU'}` };
});
await caso('revisão dos antigos: lista quem tem CPF + nascimento e ainda não foi conferido; depois de conferido sai da lista; erro volta só após 30 min', async () => {
  const c2 = await iniciar('Antigo Dois Teste'); await como(''); await garantirPedido(c2.c);
  await db.query(`update public.pre_agendamentos set paciente = '{"cpf":"529.982.247-25","dt_nasc":"1975-07-04"}'::jsonb where conversa_id = $1`, [c2.c]);
  const l1 = await um(`select public.klingo_revisao_pendentes(10) r`);
  await rpc('klingo_identidade_registrar', { p_cpf: '52998224725', p_nasc: '1975-07-04', p_r: { situacao: 'erro' }, p_conversa: null });
  const l2 = await um(`select public.klingo_revisao_pendentes(10) r`);
  await db.query(`update public.klingo_identidade set conferido_em = now() - interval '31 minutes' where situacao = 'erro'`);
  const l3 = await um(`select public.klingo_revisao_pendentes(10) r`);
  await rpc('klingo_identidade_registrar', { p_cpf: '52998224725', p_nasc: '1975-07-04', p_r: { situacao: 'nao_encontrado' }, p_conversa: null });
  const l4 = await um(`select public.klingo_revisao_pendentes(10) r`);
  return { ok: l1.r.length === 1 && l1.r[0].cpf === '52998224725' && l2.r.length === 0 && l3.r.length === 1 && l4.r.length === 0, detalhe: `${l1.r.length} > ${l2.r.length} (erro) > ${l3.r.length} (30 min) > ${l4.r.length}` };
});
await caso('a rotina de revisão não rebaixa um vínculo que o relatório já confirmou nem mexe no prontuário do relatório', async () => {
  const c3 = await iniciar('Relatorio Confirmou'); await como(''); await garantirPedido(c3.c);
  await db.query(`update public.pre_agendamentos set paciente = '{"cpf":"390.533.447-05","dt_nasc":"1990-01-10"}'::jsonb where conversa_id = $1`, [c3.c]);
  await db.query(`insert into public.paciente_klingo_vinculo (conversa_id, situacao, prontuario, chave) values ($1, 'confere', '777', 'x')`, [c3.c]);
  await rpc('klingo_identidade_registrar', { p_cpf: '39053344705', p_nasc: '1990-01-10', p_r: { situacao: 'nao_encontrado' }, p_conversa: null });
  const v = await um(`select situacao, prontuario from public.paciente_klingo_vinculo where conversa_id = $1`, [c3.c]);
  await rpc('klingo_identidade_registrar', { p_cpf: '39053344705', p_nasc: '1990-01-10', p_r: { situacao: 'confere', klingo_id: 'P888' }, p_conversa: null });
  const v2 = await um(`select situacao, prontuario from public.paciente_klingo_vinculo where conversa_id = $1`, [c3.c]);
  const m = await um(`select tipo from public.klingo_medida where tipo like 'prontuario_%'`);
  return { ok: v.situacao === 'confere' && v.prontuario === '777' && v2.prontuario === '777' && m.tipo === 'prontuario_diferente_id_api', detalhe: `vínculo ${v.situacao}/${v2.prontuario}; medida ${m.tipo}` };
});

// ---------------------------------------------------------------- 3. tradução de convênio e cota
await caso('tradução do convênio: Particular = plano 1; convênio com plano padrão usa o do cadastro SE for do mesmo convênio; sem tradução não marca', async () => {
  const r = async (o, pc = null) => (await um(`select public.klingo_plano_resolver($1, $2) r`, [o, pc])).r;
  const a = await r('Particular', 8), b = await r('Amil', 14), c = await r('Amil', 8), d = await r('Sulamerica', 700), e = await r('Sulamerica', null), f = await r('Convenio Fantasma'), g = await r('qualquer texto');
  return { ok: a.plano_id === 1 && b.plano_id === 14 && c.plano_id === 14 && c.via === 'padrao' && d.plano_id === 700 && d.via === 'cadastro' && e.plano_id === null && e.motivo === 'plano_do_cadastro_necessario'
    && f.plano_id === null && g.plano_id === null, detalhe: JSON.stringify({ a, c, d, e }) };
});
await caso('o catálogo do Klingo vira tradução sozinho: convênio com o mesmo nome do plano é traduzido, o resto fica "não atende" até a equipe escolher', async () => {
  await db.query(`insert into public.catalogo_plano (operadora, plano, produto, busca, ativo) values ('PLANSERV', 'X', 'X', ''::tsvector, true), ('ASSEFAZ', 'X', 'X', ''::tsvector, true)`);
  const r = await um(`select public.klingo_catalogo_gravar($1::jsonb) r`, [JSON.stringify({ convenios: [{ id: 20, nome: 'PLANSERV', planos: [{ id: 28, nome: 'PLANSERV' }, { id: 29, nome: 'PLANSERV PLUS' }] }], especialidades: [{ cbos: '225112', nome: 'NEUROLOGIA', codigo: '56', procedimentos: [1096, 1472] }] })]);
  const m = await q(`select operadora, plano_id, origem from public.klingo_plano_map where operadora in ('PLANSERV', 'ASSEFAZ') order by operadora`);
  await db.query(`update public.klingo_plano_map set plano_id = 99, origem = 'manual' where operadora = 'PLANSERV'`);
  await um(`select public.klingo_plano_mapear_auto()`);
  const m2 = await um(`select plano_id, origem from public.klingo_plano_map where operadora = 'PLANSERV'`);
  return { ok: m[1].plano_id === 28 && m[1].origem === 'auto' && m[0].origem === 'nao_atende' && m2.plano_id === 99 && m2.origem === 'manual' && r.r.especialidades === 1, detalhe: `${JSON.stringify(m)}; escolha manual preservada: ${m2.plano_id}` };
});
await caso('cota global: 10 fichas de uma vez, a 11ª manda esperar; o 429 do Klingo pausa todo mundo por 60 s', async () => {
  let ok = 0; for (let i = 0; i < 10; i++) if ((await um(`select public.klingo_cota_pegar(1) r`)).r.ok) ok++;
  const onze = (await um(`select public.klingo_cota_pegar(1) r`)).r;
  await um(`select public.klingo_cota_429()`);
  const pausada = (await um(`select public.klingo_cota_pegar(1) r`)).r;
  await db.exec(`update public.klingo_cota set fichas = 10, pausado_ate = null`);
  return { ok: ok === 10 && onze.ok === false && onze.espera_ms > 0 && pausada.ok === false && pausada.motivo === 'pausado' && pausada.espera_ms > 50000, detalhe: `${ok} ok; 11ª espera ${onze.espera_ms} ms; pausa ${Math.round(pausada.espera_ms / 1000)} s` };
});

// ---------------------------------------------------------------- 4. a automação ligada: marcar sozinho
let sucesso, opSucesso;
await caso('API ligada: o calendário só mostra horários que a API também oferece e o escolhido guarda a chave do Klingo', async () => {
  await cfg('klingo_api_horarios', 'sim'); await cfg('klingo_api_marcar', 'sim'); await cfg('klingo_api_percentual', '100');
  let oferta;
  sucesso = await ateOFim(await iniciar('Paciente Automatico Teste'), { motivo: 'exame', plano: 'Particular', confirmar: 'ok', antesDoHorario: async (p) => { oferta = await ofertar(p); } });
  const pa = await pedidoDe(sucesso.c), esc = pa.escolha_horario[0];
  const todos = sucesso.horarios.dias.flatMap((d) => d.slots);
  return { ok: sucesso.horarios.klingo_api === true && sucesso.horarios.aviso === null && todos.length >= 1 && todos.every((s) => s.hora === oferta.hora && String(s.profissional).includes('EXEMPLO'))
    && esc.klingo_chave === oferta.chave && sucesso.passos.at(-1) === 'marcando', detalhe: `${todos.length} horário(s) conferido(s) pela API; passos: ${sucesso.passos.slice(-3).join(' > ')}` };
});
await caso('ao confirmar: o chat diz "marcando", cria UMA operação sem dado pessoal e chama o executor só com o id (segredo do cofre)', async () => {
  const f = await fluxoDe(sucesso.c), cv = await conversaDe(sucesso.c), pa = await pedidoDe(sucesso.c);
  const ops = await q(`select * from public.klingo_operacao where conversa_id = $1`, [sucesso.c]);
  const ch = await q(`select url, body, headers from net.chamadas where url like '%klingo-executar' order by id desc limit 1`);
  opSucesso = ops[0];
  const pii = JSON.stringify(ops[0]).match(/11144477735|1980-03-25|Maria|Paciente Automatico/);
  return { ok: f.passo === 'marcando' && cv.ia_ativa === true && cv.status === 'aguardando' && pa.status === 'rascunho' && ops.length === 1 && ops[0].estado === 'pendente' && ops[0].tipo === 'marcar' && !pii
    && ch.length === 1 && Object.keys(ch[0].body).join() === 'operacao_id' && ch[0].body.operacao_id === ops[0].id && ch[0].headers['x-klingo-segredo'] === 'interno-de-teste',
    detalhe: `passo ${f.passo}; operação ${ops[0].estado}; corpo da chamada: ${Object.keys(ch[0].body)}` };
});
await caso('duplo toque: criar a operação de novo devolve a MESMA operação e não chama o Klingo outra vez', async () => {
  const antes = (await um(`select count(*)::int n from net.chamadas where url like '%klingo-executar'`)).n;
  const r = await um(`select public.klingo_operacao_criar($1) id`, [sucesso.c]);
  const depois = (await um(`select count(*)::int n from net.chamadas where url like '%klingo-executar'`)).n;
  const n = (await um(`select count(*)::int n from public.klingo_operacao where conversa_id = $1`, [sucesso.c])).n;
  return { ok: r.id === opSucesso.id && antes === depois && n === 1, detalhe: `mesma operação=${r.id === opSucesso.id}; chamadas ${antes} > ${depois}` };
});
await caso('o executor só pega a operação UMA vez (duas chamadas ao mesmo tempo não marcam duas vezes)', async () => {
  const a = (await um(`select public.klingo_operacao_pegar($1) r`, [opSucesso.id])).r, b = (await um(`select public.klingo_operacao_pegar($1) r`, [opSucesso.id])).r;
  const pii = a.dados.cpf === '11144477735' && a.dados.nascimento === '1980-03-25' && a.oferta.chave.includes('|63|308|2|');
  return { ok: a.ok === true && b.ok === false && b.motivo === 'nao_pendente' && pii && a.operacao.tentativas === 1, detalhe: `1ª: ${a.ok}; 2ª: ${b.ok} (${b.motivo})` };
});
await caso('SUCESSO: o pedido vira "agendado" com origem chat_api e o voucher; o paciente recebe o cartão e o menu; nada foi para a equipe', async () => {
  const hora = opSucesso.detalhe.hora, data = opSucesso.detalhe.data;
  const r = (await um(`select public.klingo_operacao_concluir($1, 'sucesso', $2::jsonb) r`, [opSucesso.id, JSON.stringify({ voucher: { id: '26650', status: 'agendado', data, hora, procedimento: 'RM JOELHO', unidade: 'DESENVOAR', profissional: 'EXEMPLO UM SILVA' }, http_status: 200, caminho: '/agenda/horario' })])).r;
  const pa = await pedidoDe(sucesso.c), cv = await conversaDe(sucesso.c), f = await fluxoDe(sucesso.c);
  const ms = await q(`select texto, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 2`, [sucesso.c]);
  const op = await um(`select estado, voucher_id from public.klingo_operacao where id = $1`, [opSucesso.id]);
  const rep = (await um(`select public.klingo_operacao_concluir($1, 'sucesso', '{}'::jsonb) r`, [opSucesso.id])).r;
  return { ok: r.estado === 'sucesso' && pa.status === 'agendado' && pa.agendado_origem === 'chat_api' && pa.klingo_marcacoes[0] === '26650' && pa.escolha_horario[0].origem === 'klingo_api'
    && cv.ia_ativa === true && cv.primeiro_humano_em === null && f.passo === 'pos_menu' && /confirmado no sistema da clínica/.test(ms[1].texto) && ms[1].opcoes.tipo === 'marcado' && ms[1].opcoes.voucher.id === '26650'
    && ms[0].opcoes.passo === 'pos_menu' && op.estado === 'sucesso' && op.voucher_id === '26650' && rep.repetido === true, detalhe: `pedido ${pa.status}/${pa.agendado_origem}; menu: ${ms[0].opcoes.itens.map((i) => i.valor)}` };
});
await caso('depois da marcação o paciente usa o menu: "Ver a minha marcação" mostra o protocolo; "Falar com a equipe" chama uma pessoa', async () => {
  const p = sucesso; p.ult = (await q(`select id, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [p.c]))[0];
  await anonimo();
  const r1 = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: 'pos_menu', p_valor: JSON.stringify('ver'), p_texto: 'Ver a minha marcação' });
  const ver = r1.respostas.filter((m) => m.autor === 'agente').at(-1);
  const r2 = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: 'pos_menu', p_valor: JSON.stringify('equipe'), p_texto: 'Falar com a equipe' });
  await como('');
  const cv = await conversaDe(p.c);
  return { ok: /Protocolo: 26650/.test(ver.texto) && ver.opcoes.passo === 'pos_menu' && cv.ia_ativa === false && /remarcar, cancelar/.test(cv.triagem_resumo), detalhe: ver.texto.replace(/\n/g, ' | ').slice(0, 110) };
});

// ---------------------------------------------------------------- 5. quando não dá certo
const novaOperacao = async (nome, mexer) => {
  const p = await ateOFim(await iniciar(nome), { motivo: 'exame', plano: 'Particular', confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  const op = await um(`select * from public.klingo_operacao where conversa_id = $1`, [p.c]);
  await um(`select public.klingo_operacao_pegar($1)`, [op.id]);
  return { p, op };
};
await caso('HORÁRIO TOMADO: a oferta some, o pedido volta à escolha do horário com a lista nova e nada vai para a equipe', async () => {
  const { p, op } = await novaOperacao('Horario Tomado Teste');
  await um(`select public.klingo_operacao_concluir($1, 'horario_tomado', '{"codigo":"horario_ocupado","http_status":400}'::jsonb)`, [op.id]);
  const pa = await pedidoDe(p.c), f = await fluxoDe(p.c), cv = await conversaDe(p.c), of = (await um(`select count(*)::int n from public.klingo_oferta where conversa_id = $1`, [p.c])).n;
  const ult = (await q(`select texto, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [p.c]))[0];
  return { ok: pa.escolha_horario === null && f.passo === 'horario' && cv.ia_ativa === true && of === 0 && /acabou de ser ocupado/.test(ult.texto) && ult.opcoes.tipo === 'calendario', detalhe: `passo ${f.passo}; oferta apagada=${of === 0}` };
});
await caso('INCERTO (o Klingo não confirmou): vai para a equipe com urgência média e a nota "conferir ANTES de marcar de novo"', async () => {
  const { p, op } = await novaOperacao('Incerto Teste');
  await um(`select public.klingo_operacao_concluir($1, 'incerto', '{"codigo":"timeout"}'::jsonb)`, [op.id]);
  const pa = await pedidoDe(p.c), cv = await conversaDe(p.c), f = await fluxoDe(p.c);
  const c2 = await um(`select triagem_urgencia from public.conversas where id = $1`, [p.c]);
  return { ok: pa.status === 'pronto' && cv.ia_ativa === false && c2.triagem_urgencia === 'media' && /INCERTA/.test((f.dados.notas || []).join(' ')) && /Marcação automática: incerto \(timeout\)/.test(cv.triagem_resumo), detalhe: `${pa.status}; urgência ${c2.triagem_urgencia}` };
});
await caso('FALHA de convênio (plano inativo): o paciente é avisado e a equipe resolve; o motivo fica no resumo', async () => {
  const { p, op } = await novaOperacao('Plano Inativo Teste');
  await um(`select public.klingo_operacao_concluir($1, 'falha', '{"codigo":"plano_inativo","http_status":403}'::jsonb)`, [op.id]);
  const pa = await pedidoDe(p.c), cv = await conversaDe(p.c), ult = (await q(`select texto from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 2`, [p.c]));
  return { ok: pa.status === 'pronto' && cv.ia_ativa === false && /plano_inativo/.test(cv.triagem_resumo) && ult.some((m) => /convênio Particular/.test(m.texto)), detalhe: ult[0].texto.slice(0, 70) };
});
await caso('operação sem resposta do executor: a rotina refaz a chamada e, depois de 3 tentativas, marca INCERTO e chama a equipe (nunca fica presa)', async () => {
  const { p, op } = await novaOperacao('Executor Mudo Teste');
  await db.query(`update public.klingo_operacao set estado = 'pendente', criado_em = now() - interval '2 minutes', tentativas = 1 where id = $1`, [op.id]);
  const antes = (await um(`select count(*)::int n from net.chamadas where url like '%klingo-executar'`)).n;
  const a = (await um(`select public.klingo_operacao_vigiar() r`)).r;
  const depois = (await um(`select count(*)::int n from net.chamadas where url like '%klingo-executar'`)).n;
  await db.query(`update public.klingo_operacao set estado = 'executando', iniciado_em = now() - interval '5 minutes' where id = $1`, [op.id]);
  const b = (await um(`select public.klingo_operacao_vigiar() r`)).r;
  const o2 = await um(`select estado, codigo from public.klingo_operacao where id = $1`, [op.id]), cv = await conversaDe(p.c);
  return { ok: a.redisparadas >= 1 && depois === antes + 1 && b.incertas === 1 && o2.estado === 'incerto' && o2.codigo === 'sem_resposta_do_executor' && cv.ia_ativa === false, detalhe: `refeita ${a.redisparadas}; depois ${o2.estado}/${o2.codigo}` };
});
await caso('conversa resolvida sozinha e parada há 2 h é encerrada pelo sistema (motivo "agendado"); a que teve atendente humano fica como está', async () => {
  const outro = await ateOFim(await iniciar('Resolvida Sozinha Teste'), { motivo: 'exame', plano: 'Particular', confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  const op = await um(`select * from public.klingo_operacao where conversa_id = $1`, [outro.c]);
  await um(`select public.klingo_operacao_pegar($1)`, [op.id]);
  await um(`select public.klingo_operacao_concluir($1, 'sucesso', $2::jsonb)`, [op.id, JSON.stringify({ voucher: { id: '26651', data: op.detalhe.data, hora: op.detalhe.hora, procedimento: 'RM JOELHO' } })]);
  const agora = await um(`select public.klingo_operacao_vigiar() r`);
  await db.query(`update public.pre_agendamentos set agendado_auto_em = now() - interval '3 hours' where conversa_id = $1`, [outro.c]);
  await db.query(`update public.mensagens set criado_em = now() - interval '3 hours' where conversa_id = $1`, [outro.c]);
  const dep = await um(`select public.klingo_operacao_vigiar() r`), cv = await conversaDe(outro.c);
  return { ok: agora.r.encerradas === 0 && dep.r.encerradas >= 1 && cv.status === 'encerrada' && cv.motivo_encerramento === 'agendado' && cv.encerramento_origem === 'sistema', detalhe: `${cv.status}/${cv.motivo_encerramento}/${cv.encerramento_origem}` };
});

await caso('texto livre enquanto marca ("Ainda estou finalizando") e depois de marcado (volta o menu): nada é transferido por engano', async () => {
  const p = await ateOFim(await iniciar('Texto Livre Teste'), { motivo: 'exame', plano: 'Particular', confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  await anonimo();
  const r1 = await rpc('chat_enviar', { p_conversa: p.c, p_token: p.t, p_texto: 'já deu?' });
  const a = (r1.respostas || (await rpc('chat_listar', { p_conversa: p.c, p_token: p.t, p_apos: 0 })).mensagens).filter((m) => m.autor === 'agente').at(-1);
  await como('');
  const cv1 = await conversaDe(p.c);
  const op = await um(`select * from public.klingo_operacao where conversa_id = $1`, [p.c]);
  await um(`select public.klingo_operacao_pegar($1)`, [op.id]);
  await um(`select public.klingo_operacao_concluir($1, 'sucesso', $2::jsonb)`, [op.id, JSON.stringify({ voucher: { id: '26660', data: op.detalhe.data, hora: op.detalhe.hora, procedimento: 'RM JOELHO' } })]);
  await anonimo();
  await rpc('chat_enviar', { p_conversa: p.c, p_token: p.t, p_texto: 'obrigada!' });
  await como('');
  const ult = (await q(`select texto, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [p.c]))[0], cv2 = await conversaDe(p.c);
  return { ok: /finalizando/.test(a.texto) && cv1.ia_ativa === true && ult.opcoes && ult.opcoes.passo === 'pos_menu' && cv2.ia_ativa === true && cv2.primeiro_humano_em === null, detalhe: `${a.texto.slice(0, 40)} | depois: ${ult.opcoes && ult.opcoes.passo}` };
});

// ---------------------------------------------------------------- 6. quando a automação NÃO deve marcar (vai para a equipe como sempre)
const motivoDe = async (conv) => (await um(`select public.klingo_pode_marcar($1) r`, [conv])).r;
await caso('NÃO marca sozinho: interruptor desligado, telefone fora da lista no modo "teste", percentual 0, 2 exames, convênio sem tradução, exame com convênio', async () => {
  const p = await ateOFim(await iniciar('Pode Marcar Teste'), { motivo: 'exame', plano: 'Particular', confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  await db.query(`update public.pre_agendamentos set status = 'rascunho' where conversa_id = $1`, [p.c]);
  const base = await motivoDe(p.c);
  await cfg('klingo_api_marcar', 'nao'); const m1 = await motivoDe(p.c);
  await cfg('klingo_api_marcar', 'teste'); const m2 = await motivoDe(p.c);
  await cfg('klingo_api_telefones_teste', `55${p.tel}`); const m3 = await motivoDe(p.c);
  await cfg('klingo_api_marcar', 'sim'); await cfg('klingo_api_percentual', '0'); await cfg('klingo_api_telefones_teste', ''); const m4 = await motivoDe(p.c);
  await cfg('klingo_api_percentual', '100');
  await db.query(`update public.pre_agendamentos set plano = 'Amil' where conversa_id = $1`, [p.c]); const m5 = await motivoDe(p.c);
  await db.query(`update public.pre_agendamentos set plano = 'Convenio Fantasma' where conversa_id = $1`, [p.c]); const m6 = await motivoDe(p.c);
  await db.query(`update public.pre_agendamentos set plano = 'Particular' where conversa_id = $1`, [p.c]);
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento) values ($1, 'RM', 'JOELHO', 'Joelho', 'E', 201, 'RM JOELHO E')`, [p.c]);
  const m7 = await motivoDe(p.c);
  return { ok: base.ok === true && m1.motivo === 'desligado' && m2.motivo === 'desligado' && m3.ok === true && m4.motivo === 'desligado' && m5.motivo === 'exame_com_convenio' && m6.motivo === 'sem_traducao' && m7.motivo === 'varios_procedimentos',
    detalhe: [m1, m2, m3, m4, m5, m6, m7].map((m) => m.motivo || 'ok').join(' | ') };
});
await caso('NÃO marca sozinho: sem oferta da API (ou vencida), cadastro com nascimento divergente, paciente novo sem a liberação do pré-cadastro, CPF ausente', async () => {
  const p = await ateOFim(await iniciar('Pode Marcar Dois'), { motivo: 'exame', plano: 'Particular', confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  await db.query(`update public.pre_agendamentos set status = 'rascunho' where conversa_id = $1`, [p.c]);
  await db.query(`update public.klingo_oferta set expira_em = now() - interval '1 hour' where conversa_id = $1`, [p.c]); const a = await motivoDe(p.c);
  await db.query(`update public.klingo_oferta set expira_em = now() + interval '1 hour' where conversa_id = $1`, [p.c]);
  await rpc('klingo_identidade_registrar', { p_cpf: '11144477735', p_nasc: '1980-03-25', p_r: { situacao: 'divergente' }, p_conversa: null }); const b = await motivoDe(p.c);
  await rpc('klingo_identidade_registrar', { p_cpf: '11144477735', p_nasc: '1980-03-25', p_r: { situacao: 'nao_encontrado' }, p_conversa: null }); const c = await motivoDe(p.c);
  await cfg('klingo_api_pre_cadastro', 'sim'); const d = await motivoDe(p.c); await cfg('klingo_api_pre_cadastro', 'teste');
  await db.query(`update public.pre_agendamentos set paciente = paciente - 'cpf' where conversa_id = $1`, [p.c]); const e = await motivoDe(p.c);
  return { ok: a.motivo === 'sem_oferta_da_api' && b.motivo === 'cadastro_divergente' && c.motivo === 'paciente_novo' && d.ok === true && d.novo === true && e.motivo === 'dados_incompletos', detalhe: [a, b, c, d, e].map((m) => m.motivo || 'ok').join(' | ') };
});
await caso('modo SOMBRA: a tela não muda (sem horários da API, aviso de previsão) e a automação não marca', async () => {
  await cfg('klingo_api_horarios', 'sombra');
  const p = await ateOFim(await iniciar('Sombra Teste'), { motivo: 'exame', plano: 'Particular', confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  const pa = await pedidoDe(p.c), n = (await um(`select count(*)::int n from public.klingo_operacao where conversa_id = $1`, [p.c])).n;
  await cfg('klingo_api_horarios', 'sim');
  return { ok: p.horarios.klingo_api === false && pa.status === 'pronto' && n === 0 && pa.escolha_horario[0].klingo_chave === undefined, detalhe: `klingo_api=${p.horarios.klingo_api}; pedido ${pa.status}; operações ${n}` };
});

// ---------------------------------------------------------------- 7. segurança
await caso('o paciente (anon) e a equipe logada NÃO executam nenhuma função da automação nem leem as tabelas novas', async () => {
  const fns = ['klingo_operacao_criar(uuid)', 'klingo_operacao_concluir(uuid,text,jsonb)', 'klingo_operacao_pegar(uuid)', 'klingo_oferta_gravar(uuid,integer,integer,jsonb)', 'klingo_identidade_registrar(text,date,jsonb,uuid)',
    'klingo_dados_conversa(uuid)', 'klingo_revisao_pendentes(integer)', 'klingo_cota_pegar(integer)', 'klingo_segredo()', 'klingo_hash(text)', 'klingo_pode_marcar(uuid)', 'klingo_catalogo_gravar(jsonb)', 'fluxo_finalizar_humano(uuid,text,text,text)'];
  const exec = await q(`select p, has_function_privilege('anon', p::regprocedure, 'execute') a, has_function_privilege('authenticated', p::regprocedure, 'execute') u from unnest($1::text[]) p`, [fns.map((f) => `public.${f}`)]);
  const tabs = ['klingo_operacao', 'klingo_oferta', 'klingo_identidade', 'klingo_cota', 'klingo_evento', 'klingo_medida', 'klingo_plano_map', 'klingo_convenio', 'klingo_conversa_ident'];
  await anonimo(); const lidas = [];
  for (const t of tabs) { const e = await erroDe(() => db.query(`select 1 from public.${t} limit 1`)); const r = e ? 0 : (await q(`select count(*)::int n from public.${t}`))[0].n; lidas.push(r); }
  await como('');
  return { ok: exec.every((x) => !x.a && !x.u) && lidas.every((n) => n === 0), detalhe: `${exec.filter((x) => x.a || x.u).length} funções abertas; linhas legíveis por anon: ${lidas.join(',')}` };
});
await caso('o segredo interno só confere com o valor exato e o hash do CPF muda com o CPF (HMAC com sal do cofre)', async () => {
  const a = (await um(`select public.klingo_segredo_ok('interno-de-teste') r`)).r, b = (await um(`select public.klingo_segredo_ok('interno-de-testf') r`)).r, c = (await um(`select public.klingo_segredo_ok('') r`)).r, d = (await um(`select public.klingo_segredo_ok(null) r`)).r;
  const h1 = (await um(`select public.klingo_hash('11144477735') h`)).h, h2 = (await um(`select public.klingo_hash('11144477736') h`)).h;
  return { ok: a === true && b === false && c === false && d === false && h1 !== h2 && h1.length === 64 && !h1.includes('1114447'), detalhe: 'ok' };
});

// ---------------------------------------------------------------- 8. nada do que existia foi quebrado
await caso('a regra de origem do "agendado" continua: equipe, reconhecido pelo Klingo e chat_api; ao sair de agendado a origem limpa', async () => {
  const c = await iniciar('Origem Teste'); await como(''); await garantirPedido(c.c);
  await db.query(`update public.pre_agendamentos set status = 'agendado', agendado_auto_em = now() where conversa_id = $1`, [c.c]);
  const a = await pedidoDe(c.c);
  await db.query(`update public.pre_agendamentos set status = 'pronto' where conversa_id = $1`, [c.c]);
  const b = await pedidoDe(c.c);
  return { ok: a.agendado_origem === 'reconhecido' && b.agendado_origem === null, detalhe: `${a.agendado_origem} > ${b.agendado_origem}` };
});


// ---------------------------------------------------------------- 9. autogestão: o sistema avança e recua sozinho
const medida = (tipo, n) => db.query(`insert into public.klingo_medida (dia, tipo, n) values ((now() at time zone 'America/Bahia')::date, $1, $2) on conflict (dia, tipo) do update set n = $2`, [tipo, n]);
await caso('MODO SOMBRA mede a divergência entre a API e a grade sem mudar nada para o paciente', async () => {
  await cfg('klingo_api_horarios', 'sombra');
  const p = await ateOFim(await iniciar('Sombra Mede Teste'), { motivo: 'exame', plano: 'Particular', antesDoHorario: async (x) => { await ofertar(x); await um(`select public.klingo_sombra_medir($1)`, [x.c]); } });
  const m = Object.fromEntries((await q(`select tipo, n::int from public.klingo_medida where tipo like 'sombra_%'`)).map((r) => [r.tipo, r.n]));
  await cfg('klingo_api_horarios', 'sim');
  return { ok: m.sombra_api === 1 && m.sombra_grade >= 1 && m.sombra_api_na_grade === 1 && m.sombra_grade_na_api === 1, detalhe: JSON.stringify(m) };
});
await caso('horários: sombra -> sim quando a API foi bem por 7 dias e bate com a grade; fica registrado e a gestão é avisada', async () => {
  await db.exec(`delete from public.klingo_medida; delete from public.klingo_decisao; delete from public.equipe_notificacao; delete from public.klingo_operacao;`);
  await cfg('klingo_api_marcar', 'teste');
  await db.exec(`insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000a1', 'admin@exemplo.invalid') on conflict do nothing; insert into public.agentes (id, nome, email, papel, ativo) values ('00000000-0000-4000-8000-0000000000a1', 'Admin Teste', 'admin@exemplo.invalid', 'admin', true) on conflict do nothing`);
  await cfg('klingo_api_horarios', 'sombra');
  await medida('horarios_api_ok', 20); await medida('sombra_api', 100); await medida('sombra_api_na_grade', 90);
  const antes = (await um(`select public.klingo_autogestao() r`)).r;   // ainda pouco dado
  await medida('horarios_api_ok', 40); await medida('sombra_api', 300); await medida('sombra_api_na_grade', 280);
  const depois = (await um(`select public.klingo_autogestao() r`)).r;
  const h = await um(`select valor from public.config where chave = 'klingo_api_horarios'`), dec = await um(`select count(*)::int n from public.klingo_decisao where chave = 'klingo_api_horarios' and para = 'sim'`), nt = await um(`select count(*)::int n from public.equipe_notificacao where tipo = 'klingo_autogestao'`);
  return { ok: antes.acoes.length === 0 && depois.acoes.includes('horarios:avancou') && h.valor === 'sim' && dec.n === 1 && nt.n >= 1, detalhe: `antes=${JSON.stringify(antes.acoes)} depois=${JSON.stringify(depois.acoes)} cfg=${h.valor} decisoes=${dec.n}; aviso à gestão: ${nt.n}` };
});
await caso('horários: sim -> sombra quando a API falha em metade das chamadas do dia (e não oscila: espera 30 min)', async () => {
  await medida('horarios_api_erro', 30); await medida('horarios_api_ok', 20);
  const a = (await um(`select public.klingo_autogestao() r`)).r;
  const h = await um(`select valor from public.config where chave = 'klingo_api_horarios'`);
  await cfg('klingo_api_horarios', 'sim');
  const b = (await um(`select public.klingo_autogestao() r`)).r;
  const h2 = await um(`select valor from public.config where chave = 'klingo_api_horarios'`);
  await cfg('klingo_api_horarios', 'sombra');
  return { ok: a.acoes.includes('horarios:recuou') && h.valor === 'sombra' && b.acoes.length === 0 && h2.valor === 'sim', detalhe: `${JSON.stringify(a.acoes)}; logo depois: ${JSON.stringify(b.acoes)}` };
});
const op = async (estado, codigo = null, idade = '1 hour') => db.query(`insert into public.klingo_operacao (conversa_id, tipo, chave_idem, estado, codigo, criado_em) select c.id, 'marcar', gen_random_uuid()::text, $1, $2, now() - $3::interval from public.conversas c limit 1`, [estado, codigo, idade]);
await caso('marcar: teste -> 10% só depois de 20 marcações de teste sem nenhuma incerta; 10% -> 50% -> 100% a cada 2 dias com sucesso alto', async () => {
  await db.exec(`delete from public.klingo_operacao; delete from public.klingo_decisao;`);
  await cfg('klingo_api_marcar', 'teste'); await cfg('klingo_api_percentual', '100');
  for (let i = 0; i < 19; i++) await op('sucesso', null, '3 days');
  const a = (await um(`select public.klingo_autogestao() r`)).r;
  await op('sucesso', null, '3 days');
  await op('falha', 'plano_inativo', '3 days');   // falha de regra de negócio não conta como técnica
  const b = (await um(`select public.klingo_autogestao() r`)).r;
  const m = await um(`select valor from public.config where chave = 'klingo_api_marcar'`), pc = await um(`select valor from public.config where chave = 'klingo_api_percentual'`);
  await db.exec(`update public.klingo_decisao set em = now() - interval '3 days'`);
  for (let i = 0; i < 10; i++) await op('sucesso', null, '1 hour');
  const c1 = (await um(`select public.klingo_autogestao() r`)).r; const pc2 = await um(`select valor from public.config where chave = 'klingo_api_percentual'`);
  await db.exec(`update public.klingo_decisao set em = now() - interval '3 days'`);
  for (let i = 0; i < 10; i++) await op('sucesso', null, '1 minute');
  const c2 = (await um(`select public.klingo_autogestao() r`)).r; const pc3 = await um(`select valor from public.config where chave = 'klingo_api_percentual'`);
  return { ok: a.acoes.length === 0 && b.acoes.includes('marcar:avancou_10') && m.valor === 'sim' && pc.valor === '10' && c1.acoes.includes('marcar:avancou_pct') && pc2.valor === '50' && c2.acoes.includes('marcar:avancou_pct') && pc3.valor === '100', detalhe: `19: ${JSON.stringify(a.acoes)}; 20: ${JSON.stringify(b.acoes)}; % ${pc.valor} > ${pc2.valor} > ${pc3.valor}` };
});
await caso('marcar: com 2 incertas em 24 h (ou muitas falhas técnicas) o sistema volta sozinho para só-teste e avisa a gestão', async () => {
  await cfg('klingo_api_marcar', 'sim'); await db.exec(`update public.klingo_decisao set em = now() - interval '3 days'`);
  await op('incerto', 'timeout', '2 hours'); await op('incerto', 'timeout', '1 hour');
  const r = (await um(`select public.klingo_autogestao() r`)).r;
  const m = await um(`select valor from public.config where chave = 'klingo_api_marcar'`), nt = await um(`select count(*)::int n from public.equipe_notificacao where detalhe ->> 'para' = 'teste'`);
  return { ok: r.acoes.includes('marcar:recuou') && m.valor === 'teste' && nt.n >= 1, detalhe: `${JSON.stringify(r.acoes)}; interruptor: ${m.valor}` };
});
await caso('autogestão desligada em config: o sistema não mexe em nenhum interruptor', async () => {
  await cfg('klingo_autogestao', 'nao'); await cfg('klingo_api_marcar', 'sim'); await op('incerto', 'timeout', '1 hour');
  const r = (await um(`select public.klingo_autogestao() r`)).r, m = await um(`select valor from public.config where chave = 'klingo_api_marcar'`);
  await cfg('klingo_autogestao', 'sim'); await cfg('klingo_api_marcar', 'teste');
  return { ok: r.ligada === false && m.valor === 'sim', detalhe: JSON.stringify(r) };
});
await caso('rotinas agendadas e limpeza: vigia de operações (1 min), autogestão, revisão dos antigos, sincronização e limpeza existem; a limpeza apaga ofertas e medidas velhas', async () => {
  const j = (await q(`select jobname from cron.job where jobname like 'klingo-%' order by 1`)).map((x) => x.jobname);
  await db.exec(`insert into public.klingo_medida (dia, tipo, n) values (current_date - 100, 'velha', 1)`);
  await um(`select public.klingo_limpar()`);
  const v = await um(`select count(*)::int n from public.klingo_medida where tipo = 'velha'`);
  return { ok: ['klingo-autogestao', 'klingo-limpeza', 'klingo-operacao-vigia', 'klingo-revisar-pacientes', 'klingo-sincronizar'].every((x) => j.includes(x)) && v.n === 0, detalhe: j.join(', ') };
});

// ---------------------------------------------------------------- 10. paciente novo (pré-cadastro único por CPF) e avisos do Klingo
await caso('PRÉ-CADASTRO ÚNICO: a 1ª operação cria, a 2ª (mesmo CPF, outra conversa) é BLOQUEADA enquanto a 1ª não terminou; depois do registro todas reaproveitam o id', async () => {
  await db.exec(`delete from public.klingo_operacao; delete from public.klingo_identidade;`);
  const mk = async (nome) => { const p = await iniciar(nome); await como(''); await garantirPedido(p.c); return (await um(`insert into public.klingo_operacao (conversa_id, tipo, chave_idem, estado) values ($1, 'marcar', gen_random_uuid()::text, 'executando') returning id`, [p.c])).id; };
  const [a, b, c] = [await mk('Novo Um Teste'), await mk('Novo Dois Teste'), await mk('Novo Tres Teste')];
  const r1 = (await um(`select public.klingo_pre_reservar($1, '11144477735', '1980-03-25') r`, [a])).r;
  const r2 = (await um(`select public.klingo_pre_reservar($1, '11144477735', '1980-03-25') r`, [b])).r;
  await um(`select public.klingo_pre_gravar($1, '11144477735', '1980-03-25', '7960')`, [a]);
  await db.query(`update public.klingo_operacao set estado = 'sucesso' where id = $1`, [a]);
  const r3 = (await um(`select public.klingo_pre_reservar($1, '11144477735', '1981-01-01') r`, [c])).r;
  const id = await um(`select tipo, klingo_id, situacao from public.klingo_identidade where tipo = 'pre'`);
  const e = await erroDe(() => um(`select public.klingo_pre_gravar($1, '11144477735', '1982-02-02', 'P99')`, [c]));
  return { ok: r1.acao === 'criar' && r2.acao === 'bloqueado' && r3.acao === 'existente' && r3.klingo_id === '7960' && id.klingo_id === '7960' && id.situacao === 'pre_cadastro' && !!e, detalhe: `1ª ${r1.acao}; 2ª ${r2.acao}; depois ${r3.acao}/${r3.klingo_id}; id com P recusado: ${!!e}` };
});
await caso('registro que estourou o tempo (incerto) BLOQUEIA novos registros do mesmo CPF; se o id foi guardado na operação mas a identidade falhou, ele é reaproveitado', async () => {
  await db.exec(`delete from public.klingo_operacao; delete from public.klingo_identidade;`);
  const p = await iniciar('Incerto Novo Teste'); await como(''); await garantirPedido(p.c);
  const a = (await um(`insert into public.klingo_operacao (conversa_id, tipo, chave_idem, estado) values ($1, 'marcar', gen_random_uuid()::text, 'executando') returning id`, [p.c])).id;
  const b = (await um(`insert into public.klingo_operacao (conversa_id, tipo, chave_idem, estado) values ($1, 'marcar', gen_random_uuid()::text, 'executando') returning id`, [p.c])).id;
  await um(`select public.klingo_pre_reservar($1, '52998224725', '1975-07-04')`, [a]);
  await db.query(`update public.klingo_operacao set estado = 'incerto', codigo = 'registro_incerto', detalhe = detalhe || '{"registro_iniciado_em":"2026-01-01T00:00:00Z"}'::jsonb where id = $1`, [a]);
  const r = (await um(`select public.klingo_pre_reservar($1, '52998224725', '1975-07-04') r`, [b])).r;
  await db.query(`update public.klingo_operacao set detalhe = detalhe || '{"registro_id":"8123"}'::jsonb where id = $1`, [a]);
  const r2 = (await um(`select public.klingo_pre_reservar($1, '52998224725', '1975-07-04') r`, [b])).r;
  return { ok: r.acao === 'bloqueado' && r2.acao === 'existente' && r2.klingo_id === '8123', detalhe: `${r.acao} > ${r2.acao}/${r2.klingo_id}` };
});
await caso('AVISOS DO KLINGO (webhook): cancelada vira pedido cancelado; remarcada troca o voucher; repetido não tem efeito; id inválido é recusado', async () => {
  const p = await iniciar('Webhook Teste'); await como(''); await garantirPedido(p.c);
  await db.query(`update public.pre_agendamentos set status = 'agendado', agendado_origem = 'chat_api', klingo_marcacoes = array['26800'] where conversa_id = $1`, [p.c]);
  await db.query(`insert into public.conversa_fluxo (conversa_id) values ($1) on conflict do nothing`, [p.c]);
  const ev = async (o) => (await um(`select public.klingo_evento_aplicar($1::jsonb) r`, [JSON.stringify(o)])).r;
  const rem = await ev({ evento: 'REMARCACAO', id_marcacao: '26800', status: 'A', nova: '26801' });
  const rep = await ev({ evento: 'REMARCACAO', id_marcacao: '26800', status: 'A', nova: '26801' });
  const pa1 = await pedidoDe(p.c);
  const can = await ev({ evento: 'STATUS-MARCACAO', id_marcacao: '26801', status: 'C' });
  const pa2 = await pedidoDe(p.c), f = await fluxoDe(p.c);
  const sem = await ev({ evento: 'STATUS-MARCACAO', id_marcacao: '99999', status: 'C' });
  const ruim = await ev({ evento: 'X', id_marcacao: 'abc; drop' });
  return { ok: rem.resultado === 'remarcada' && rep.duplicado === true && pa1.klingo_marcacoes[0] === '26801' && can.resultado === 'cancelada' && pa2.status === 'cancelado' && /CANCELADA/.test((f.dados.notas || []).join(' ')) && sem.resultado === 'sem_pedido' && ruim.ok === false,
    detalhe: `${rem.resultado}; repetido=${rep.duplicado}; ${can.resultado}; ${sem.resultado}; ${ruim.motivo}` };
});
await caso('as funções da parte 6 também são só do sistema (anon e equipe logada não executam)', async () => {
  const fns = ['klingo_pre_reservar(uuid,text,date)', 'klingo_pre_gravar(uuid,text,date,text)', 'klingo_evento_aplicar(jsonb)', 'klingo_autogestao()', 'klingo_decidir(text,text,jsonb,text)', 'klingo_sombra_medir(uuid)'];
  const exec = await q(`select p, has_function_privilege('anon', p::regprocedure, 'execute') a, has_function_privilege('authenticated', p::regprocedure, 'execute') u from unnest($1::text[]) p`, [fns.map((f) => `public.${f}`)]);
  return { ok: exec.every((x) => !x.a && !x.u), detalhe: `${exec.filter((x) => x.a || x.u).length} abertas` };
});

// ---------------------------------------------------------------- 11. indicadores
await caso('INDICADORES: conversa resolvida sozinha pela automação NÃO conta como "sem atendimento humano"; abandono continua contando', async () => {
  const a = await iniciar('Indicador Auto Teste'); await como(''); await garantirPedido(a.c);
  const b = await iniciar('Indicador Abandono Teste'); await como(''); await garantirPedido(b.c);
  await db.query(`update public.pre_agendamentos set status = 'agendado', agendado_origem = 'chat_api', agendado_auto_em = now() where conversa_id = $1`, [a.c]);
  const hoje = dia(0);
  const r = await q(`select pessoa from public.ind_calc_semhumano($1::date, $1::date)`, [hoje]);
  const doA = await um(`select count(*)::int n from public.ind_calc_semhumano($1::date, $1::date) s join public.painel_conversa_pessoa_un() pu on pu.pessoa = s.pessoa where pu.conversa_id = $2`, [hoje, a.c]);
  const doB = await um(`select count(*)::int n from public.ind_calc_semhumano($1::date, $1::date) s join public.painel_conversa_pessoa_un() pu on pu.pessoa = s.pessoa where pu.conversa_id = $2`, [hoje, b.c]);
  return { ok: doA.n === 0 && doB.n >= 1, detalhe: `automação: ${doA.n}; abandono: ${doB.n}; total ${r.length}` };
});
await caso('resumo do painel: números da automação só para admin/atendente, sem nenhum dado de paciente', async () => {
  await db.exec(`insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000a9', 'admin9@exemplo.invalid') on conflict do nothing; insert into public.agentes (id, nome, email, papel, ativo) values ('00000000-0000-4000-8000-0000000000a9', 'Admin Nove', 'admin9@exemplo.invalid', 'admin', true) on conflict do nothing`);
  await como('00000000-0000-4000-8000-0000000000a9');
  const r = await um(`select public.painel_automacao_resumo() r`);
  await como('');
  await anonimo(); const e = await erroDe(() => um(`select public.painel_automacao_resumo() r`)); await como('');
  const txt = JSON.stringify(r.r);
  return { ok: ['modos', 'operacoes', 'agendadas_sozinhas', 'resolvidas_sem_humano', 'motivos_falha', 'cadastros', 'convenios', 'horarios_api', 'decisoes'].every((k) => k in r.r) && !!e && !/11144477735|Maria|1980-03-25/.test(txt) && r.r.modos.marcar !== undefined,
    detalhe: `chaves: ${Object.keys(r.r).join(',')}; anônimo: ${e ? e.code : 'LEU'}` };
});

// ---------------------------------------------------------------- 12. depois da marcação: cancelar e remarcar pelo chat
const agendadoPeloChat = async (nome, { dias = 10 } = {}) => {
  await cfg('klingo_api_horarios', 'sim'); await cfg('klingo_api_marcar', 'sim'); await cfg('klingo_api_percentual', '100');
  const p = await ateOFim(await iniciar(nome), { motivo: 'exame', plano: 'Particular', confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  const op = await um(`select * from public.klingo_operacao where conversa_id = $1 order by criado_em desc limit 1`, [p.c]);
  await um(`select public.klingo_operacao_pegar($1)`, [op.id]);
  const data = dia(dias);
  await um(`select public.klingo_operacao_concluir($1, 'sucesso', $2::jsonb)`, [op.id, JSON.stringify({ voucher: { id: String(27000 + (++seqV)), data, hora: '09:40', procedimento: 'RM JOELHO', unidade: 'DESENVOAR', profissional: 'EXEMPLO UM' } })]);
  p.voucher = String(27000 + seqV); p.data = data;
  p.ult = (await q(`select id, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [p.c]))[0];
  return p;
};
let seqV = 0;
const apertar = async (p, passo, valor) => {
  await anonimo();
  let r;
  try { r = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: passo, p_valor: JSON.stringify(valor), p_texto: valor }); } finally { await como(''); }
  const ag = (r.respostas || []).filter((m) => m.autor === 'agente');
  if (ag.length) p.ult = ag.at(-1);
  return ag;
};
const itensDoMenu = (p) => (p.ult.opcoes.itens || []).map((i) => i.valor);
await caso('o menu pós-marcação só oferece Remarcar e Cancelar com klingo_api_pos ligado e para o que ESTE chat marcou', async () => {
  await cfg('klingo_api_pos', 'nao'); await cfg('klingo_api_telefones_teste', '');
  const a = await agendadoPeloChat('Menu Pos Um');
  const sem = itensDoMenu(a);
  await cfg('klingo_api_pos', 'sim');
  await um(`select public.fluxo_pos_menu($1)`, [a.c]);
  const com = (await q(`select opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [a.c]))[0].opcoes.itens.map((i) => i.valor);
  await db.query(`update public.pre_agendamentos set agendado_origem = 'equipe' where conversa_id = $1`, [a.c]);
  await um(`select public.fluxo_pos_menu($1)`, [a.c]);
  const equipe = (await q(`select opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [a.c]))[0].opcoes.itens.map((i) => i.valor);
  return { ok: !sem.includes('cancelar') && sem.includes('equipe') && com.includes('cancelar') && com.includes('remarcar') && !equipe.includes('cancelar'), detalhe: `desligado: ${sem}; ligado: ${com}; marcado pela equipe: ${equipe}` };
});
await caso('CANCELAR: pede confirmação; "Não" volta ao menu; "Sim" cria UMA operação (duplo toque não cria outra) e o executor cancela só o voucher desta conversa', async () => {
  await cfg('klingo_api_pos', 'sim');
  const p = await agendadoPeloChat('Cancelar Teste');
  await apertar(p, 'pos_menu', 'cancelar');
  const conf = p.ult;
  await apertar(p, 'pos_cancelar', 'cancelar_nao');
  const voltou = p.ult.opcoes.passo === 'pos_menu';
  await apertar(p, 'pos_menu', 'cancelar');
  await apertar(p, 'pos_cancelar', 'cancelar_sim');
  const f1 = await fluxoDe(p.c);
  const tent = await erroDe(() => apertar(p, 'pos_cancelar', 'cancelar_sim'));   // duplo toque: passo já mudou, a tela recusa
  const ops = await q(`select * from public.klingo_operacao where conversa_id = $1 and tipo = 'cancelar'`, [p.c]);
  const ch = await q(`select body from net.chamadas where url like '%klingo-executar' order by id desc limit 1`);
  return { ok: conf.opcoes.passo === 'pos_cancelar' && voltou && ops.length === 1 && ops[0].detalhe.voucher === p.voucher && ops[0].estado === 'pendente' && f1.passo === 'marcando' && ch[0].body.operacao_id === ops[0].id && Object.keys(ch[0].body).join() === 'operacao_id' && !!tent,
    detalhe: `confirmação ${conf.opcoes.passo}; operações ${ops.length}; voucher na operação ${ops[0] && ops[0].detalhe.voucher}` };
});
await caso('CANCELAR com sucesso: pedido "cancelado", conversa encerrada e mensagem com o botão de novo pedido; com falha/incerto a equipe assume e o agendamento não é dado como cancelado', async () => {
  await cfg('klingo_api_pos', 'sim');
  const p = await agendadoPeloChat('Cancelar Sucesso');
  await apertar(p, 'pos_menu', 'cancelar'); await apertar(p, 'pos_cancelar', 'cancelar_sim');
  const op = await um(`select * from public.klingo_operacao where conversa_id = $1 and tipo = 'cancelar'`, [p.c]);
  await um(`select public.klingo_operacao_pegar($1)`, [op.id]);
  await um(`select public.klingo_operacao_concluir($1, 'sucesso', $2::jsonb)`, [op.id, JSON.stringify({ voucher: { id: p.voucher } })]);
  const pa = await pedidoDe(p.c), cv = await conversaDe(p.c), ult = (await q(`select texto, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [p.c]))[0];
  const h = await um(`select cancelado from public.paciente_historico where pre_agendamento_id = (select id from public.pre_agendamentos where conversa_id = $1)`, [p.c]);
  const q2 = await agendadoPeloChat('Cancelar Falha');
  await apertar(q2, 'pos_menu', 'cancelar'); await apertar(q2, 'pos_cancelar', 'cancelar_sim');
  const op2 = await um(`select * from public.klingo_operacao where conversa_id = $1 and tipo = 'cancelar'`, [q2.c]);
  await um(`select public.klingo_operacao_pegar($1)`, [op2.id]);
  await um(`select public.klingo_operacao_concluir($1, 'incerto', '{"codigo":"timeout"}'::jsonb)`, [op2.id]);
  const pa2 = await pedidoDe(q2.c), cv2 = await conversaDe(q2.c), f2 = await fluxoDe(q2.c);
  return { ok: pa.status === 'cancelado' && cv.status === 'encerrada' && cv.motivo_encerramento === 'desistiu' && /foi cancelado/.test(ult.texto) && ult.opcoes.tipo === 'nova'
    && pa2.status === 'agendado' && cv2.ia_ativa === false && /Cancelamento automático NÃO concluído/.test((f2.dados.notas || []).join(' ')), detalhe: `sucesso: ${pa.status}/${cv.status}; incerto: ${pa2.status}, ia_ativa=${cv2.ia_ativa}` };
});
await caso('PRAZO: cancelar ou remarcar com menos de 24 h chama a equipe sem mexer no agendamento', async () => {
  await cfg('klingo_api_pos', 'sim');
  const p = await agendadoPeloChat('Prazo Teste', { dias: 0 });
  await db.query(`update public.pre_agendamentos set escolha_horario = jsonb_set(escolha_horario, '{0,hora}', to_jsonb(to_char((now() at time zone 'America/Bahia') + interval '3 hours', 'HH24:MI'))) where conversa_id = $1`, [p.c]);
  const ag = await apertar(p, 'pos_menu', 'cancelar');
  const pa = await pedidoDe(p.c), cv = await conversaDe(p.c), ops = await q(`select 1 from public.klingo_operacao where conversa_id = $1 and tipo = 'cancelar'`, [p.c]);
  return { ok: ag.some((m) => /menos de 24 horas/.test(m.texto)) && pa.status === 'agendado' && cv.ia_ativa === false && ops.length === 0, detalhe: ag.map((m) => m.texto.slice(0, 50)).join(' | ') };
});
await caso('REMARCAR: volta ao horário, escolhe o novo, confirma e a operação "remarcar" leva o voucher antigo; o agendamento só muda quando a API confirma', async () => {
  await cfg('klingo_api_pos', 'sim');
  const p = await agendadoPeloChat('Remarcar Teste');
  const velho = p.voucher;
  await apertar(p, 'pos_menu', 'remarcar');
  const f0 = await fluxoDe(p.c), pa0 = await pedidoDe(p.c);
  await ateOFim(p, { confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  const op = await um(`select * from public.klingo_operacao where conversa_id = $1 and tipo = 'remarcar'`, [p.c]);
  const f1 = await fluxoDe(p.c);
  const pegou = (await um(`select public.klingo_operacao_pegar($1) r`, [op.id])).r;
  await um(`select public.klingo_operacao_concluir($1, 'sucesso', $2::jsonb)`, [op.id, JSON.stringify({ voucher: { id: '27999', data: op.detalhe.data, hora: op.detalhe.hora, procedimento: 'RM JOELHO', unidade: 'DESENVOAR', profissional: 'EXEMPLO UM' } })]);
  const pa = await pedidoDe(p.c), f2 = await fluxoDe(p.c);
  const ult = (await q(`select texto from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 2`, [p.c]));
  return { ok: f0.dados.remarcando.voucher === velho && f0.passo === 'horario' && pa0.status === 'agendado' && op && op.detalhe.remarcacao === velho && op.detalhe.chave && f1.passo === 'marcando' && pegou.ok
    && pa.status === 'agendado' && pa.agendado_origem === 'chat_api' && pa.klingo_marcacoes[0] === '27999' && f2.dados.remarcando === undefined && ult.some((m) => /Remarquei/.test(m.texto)),
    detalhe: `voucher ${velho} > ${pa.klingo_marcacoes[0]}; passo ${f0.passo} > ${f1.passo} > ${f2.passo}` };
});
await caso('REMARCAR que não concluiu (falha ou incerto): a equipe assume, o agendamento anterior segue como está e a nota diz qual é', async () => {
  await cfg('klingo_api_pos', 'sim');
  const p = await agendadoPeloChat('Remarcar Falha');
  const velho = p.voucher;
  await apertar(p, 'pos_menu', 'remarcar');
  await ateOFim(p, { confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  const op = await um(`select * from public.klingo_operacao where conversa_id = $1 and tipo = 'remarcar'`, [p.c]);
  await um(`select public.klingo_operacao_pegar($1)`, [op.id]);
  await um(`select public.klingo_operacao_concluir($1, 'incerto', '{"codigo":"timeout"}'::jsonb)`, [op.id]);
  const pa = await pedidoDe(p.c), cv = await conversaDe(p.c), f = await fluxoDe(p.c);
  return { ok: pa.status === 'agendado' && pa.klingo_marcacoes[0] === velho && cv.ia_ativa === false && new RegExp('voucher ' + velho).test((f.dados.notas || []).join(' ')) && /INCERTA|não confirmou/.test((f.dados.notas || []).join(' ')) && f.dados.remarcando === undefined,
    detalhe: `pedido ${pa.status}, voucher ${pa.klingo_marcacoes[0]}` };
});
await caso('REMARCAR com a automação desligada para a remarcação: a equipe resolve sem perder o agendamento atual', async () => {
  await cfg('klingo_api_pos', 'sim');
  const p = await agendadoPeloChat('Remarcar Desligado');
  await apertar(p, 'pos_menu', 'remarcar');
  await cfg('klingo_api_pos', 'nao');
  await ateOFim(p, { confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  const pa = await pedidoDe(p.c), cv = await conversaDe(p.c), f = await fluxoDe(p.c);
  await cfg('klingo_api_pos', 'sim');
  return { ok: pa.status === 'agendado' && cv.ia_ativa === false && /Remarcação pedida pelo chat/.test((f.dados.notas || []).join(' ')) && /remarcar_desligado/.test((f.dados.notas || []).join(' ')), detalhe: (f.dados.notas || []).slice(-1)[0] };
});
await caso('autogestão libera Cancelar/Remarcar quando a marcação chega a 100% e estável, e recolhe junto se a marcação recuar', async () => {
  await db.exec(`delete from public.klingo_operacao; delete from public.klingo_decisao;`);
  await cfg('klingo_api_marcar', 'sim'); await cfg('klingo_api_percentual', '100'); await cfg('klingo_api_pos', 'teste');
  await db.query(`insert into public.klingo_decisao (chave, de, para, em) values ('klingo_api_percentual', '50', '100', now() - interval '3 days')`);
  const a = (await um(`select public.klingo_autogestao() r`)).r; const pos1 = (await um(`select valor from public.config where chave = 'klingo_api_pos'`)).valor;
  await db.query(`insert into public.klingo_operacao (conversa_id, tipo, chave_idem, estado, codigo, criado_em) select c.id, 'marcar', gen_random_uuid()::text, 'incerto', 'timeout', now() - interval '1 hour' from public.conversas c limit 2`);
  const b = (await um(`select public.klingo_autogestao() r`)).r; const pos2 = (await um(`select valor from public.config where chave = 'klingo_api_pos'`)).valor;
  return { ok: a.acoes.includes('pos:avancou') && pos1 === 'sim' && b.acoes.includes('marcar:recuou') && pos2 === 'teste', detalhe: `${JSON.stringify(a.acoes)} pos=${pos1}; depois ${JSON.stringify(b.acoes)} pos=${pos2}` };
});

// ---------------------------------------------------------------- 13. "Voltar e corrigir" com o passo novo
await caso('VOLTAR: do plano volta para CPF e nascimento (já preenchidos); de lá volta ao exame; responder de novo segue até o plano', async () => {
  await cfg('klingo_api_horarios', 'nao'); await cfg('klingo_api_marcar', 'nao');
  const p = await iniciar('Voltar Cpf Teste');
  for (let i = 0; i < 8 && p.ult.opcoes.passo !== 'plano'; i++) await responder(p, { motivo: 'exame' });
  await anonimo();
  const r1 = await rpc('chat_voltar', { p_conversa: p.c, p_token: p.t });
  await como(''); const f1 = await um(`select passo from public.conversa_fluxo where conversa_id = $1`, [p.c]);
  const ult1 = r1.respostas.filter((m) => m.autor === 'agente').at(-1);
  const campos = ult1.opcoes.campos || [];
  await anonimo(); const r2 = await rpc('chat_voltar', { p_conversa: p.c, p_token: p.t });
  await como(''); const f2 = await um(`select passo from public.conversa_fluxo where conversa_id = $1`, [p.c]);
  p.ult = r2.respostas.filter((m) => m.autor === 'agente').at(-1);
  return { ok: r1.passo === 'cpf_nasc' && f1.passo === 'cpf_nasc' && (campos.find((c) => c.nome === 'cpf') || {}).valor === '11144477735' && ['exame', 'busca_exame'].includes(p.ult.opcoes.tipo === 'busca_exame' ? 'exame' : p.ult.opcoes.passo) && f2.passo === 'exame',
    detalhe: `${r1.passo} (CPF já preenchido: ${(campos.find((c) => c.nome === 'cpf') || {}).valor === '11144477735'}) > ${f2.passo}` };
});


// ---------------------------------------------------------------- 12. interruptor geral (klingo_auto): começa desligado, teste só para os telefones, sim para todos, volta sozinho para teste
await caso('INTERRUPTOR GERAL: "nao" desliga tudo (ninguém, nem telefone da lista); "teste" só a lista; "sim" todos; chave individual em "nao" desliga só aquela função', async () => {
  const p = await ateOFim(await iniciar('Mestre Teste'), { motivo: 'exame', plano: 'Particular', confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  await db.query(`update public.pre_agendamentos set status = 'rascunho' where conversa_id = $1`, [p.c]);
  const ativo = async (k) => (await um(`select public.klingo_ativo($1, $2) r`, [p.c, k])).r;
  await cfg('klingo_api_marcar', 'teste'); await cfg('klingo_api_horarios', 'sombra'); await cfg('klingo_api_pre_cadastro', 'teste'); await cfg('klingo_api_pos', 'teste'); await cfg('klingo_api_telefones_teste', `55${p.tel}`);
  await cfg('klingo_auto', 'nao');   const n1 = [await ativo('klingo_api_marcar'), await ativo('klingo_api_horarios'), await ativo('klingo_api_pre_cadastro'), await ativo('klingo_api_pos')];
  await cfg('klingo_auto', 'teste'); const t1 = [await ativo('klingo_api_marcar'), await ativo('klingo_api_horarios'), await ativo('klingo_api_pre_cadastro'), await ativo('klingo_api_pos')];
  await cfg('klingo_api_telefones_teste', '5571900000000'); const t2 = await ativo('klingo_api_marcar');
  await cfg('klingo_auto', 'sim'); const s1 = [await ativo('klingo_api_marcar'), await ativo('klingo_api_horarios'), await ativo('klingo_api_pre_cadastro'), await ativo('klingo_api_pos')];
  await cfg('klingo_api_pos', 'nao'); const s2 = await ativo('klingo_api_pos');
  await cfg('klingo_auto', 'xyz'); const x1 = await ativo('klingo_api_marcar');   // valor desconhecido = desligado
  await cfg('klingo_api_pos', 'teste'); await cfg('klingo_api_telefones_teste', ''); await cfg('klingo_auto', 'legado');
  return { ok: n1.every((v) => v === false) && t1.every((v) => v === true) && t2 === false && s1.every((v) => v === true) && s2 === false && x1 === false, detalhe: `nao=${n1} teste(lista)=${t1} teste(fora)=${t2} sim=${s1} sim+pos nao=${s2} invalido=${x1}` };
});
await caso('INTERRUPTOR GERAL desligado: a marcação sozinha não acontece e o pedido segue para a equipe; ligado em "teste" só para o telefone da lista', async () => {
  await cfg('klingo_api_horarios', 'sim'); await cfg('klingo_auto', 'legado');
  const p = await ateOFim(await iniciar('Mestre Marca'), { motivo: 'exame', plano: 'Particular', confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  await db.query(`update public.pre_agendamentos set status = 'rascunho' where conversa_id = $1`, [p.c]);
  await cfg('klingo_api_marcar', 'sim'); await cfg('klingo_api_percentual', '100'); await cfg('klingo_api_telefones_teste', `55${p.tel}`);
  await cfg('klingo_auto', 'nao'); const a = await motivoDe(p.c);
  await cfg('klingo_auto', 'teste'); const b = await motivoDe(p.c);
  await cfg('klingo_api_telefones_teste', ''); const c = await motivoDe(p.c);
  await cfg('klingo_auto', 'sim'); const d = await motivoDe(p.c);
  await cfg('klingo_api_marcar', 'teste'); await cfg('klingo_auto', 'legado');
  return { ok: a.ok === false && a.motivo === 'desligado' && b.ok === true && c.ok === false && c.motivo === 'desligado' && d.ok === true, detalhe: `nao=${a.motivo} teste(lista)=${b.ok}/${b.motivo} teste(fora)=${c.motivo} sim=${d.ok}/${d.motivo}` };
});
await caso('INTERRUPTOR GERAL em "sim": a autogestão não avança sozinha, mas VOLTA para "teste" (e avisa a gestão) quando há 2 marcações incertas; nao/teste: ela não mexe em nada', async () => {
  await db.query(`delete from public.klingo_operacao`); await db.query(`delete from public.klingo_medida`);   // começa limpo: as operações dos casos anteriores não valem aqui
  await cfg('klingo_autogestao', 'sim'); await cfg('klingo_auto', 'nao'); const r0 = (await um(`select public.klingo_autogestao() r`)).r;
  await cfg('klingo_auto', 'sim'); const r1 = (await um(`select public.klingo_autogestao() r`)).r;
  const op = async (estado, codigo) => db.query(`insert into public.klingo_operacao (tipo, conversa_id, chave_idem, estado, codigo, criado_em) select 'marcar', c.id, 'mestre-' || gen_random_uuid()::text, $1, $2, now() - interval '1 hour' from public.conversas c limit 1`, [estado, codigo]);
  await op('incerto', 'timeout'); await op('incerto', 'timeout');
  const r2 = (await um(`select public.klingo_autogestao() r`)).r, m = await um(`select valor from public.config where chave = 'klingo_auto'`), dec = await um(`select count(*)::int n from public.klingo_decisao where chave = 'klingo_auto' and para = 'teste'`);
  await db.query(`delete from public.klingo_operacao where chave_idem like 'mestre-%'`); await cfg('klingo_auto', 'legado');
  return { ok: (r0.acoes || []).length === 0 && (r1.acoes || []).length === 0 && (r2.acoes || []).includes('mestre:recuou') && m.valor === 'teste' && dec.n === 1, detalhe: `nao=${JSON.stringify(r0.acoes)} sim=${JSON.stringify(r1.acoes)} depois=${JSON.stringify(r2.acoes)} valor=${m.valor}` };
});
await caso('a migração começa com o interruptor geral DESLIGADO e só o service_role chama klingo_mestre', async () => {
  const sql = readFileSync(`${REPO}/supabase/klingo-auto-parte10-interruptor-geral.sql`, 'utf8');
  const g = await q(`select has_function_privilege('anon', 'public.klingo_mestre()', 'execute') a, has_function_privilege('authenticated', 'public.klingo_mestre()', 'execute') b, has_function_privilege('service_role', 'public.klingo_mestre()', 'execute') c`);
  return { ok: /values \('klingo_auto', 'nao'\)/.test(sql) && g[0].a === false && g[0].b === false && g[0].c === true, detalhe: JSON.stringify(g[0]) };
});


// ---------------------------------------------------------------- 13. parte 11: voltar seguro, uma operação por pedido, nome da mãe e divergência de cadastro
const marcando = async (nome) => {
  await cfg('klingo_auto', 'legado'); await cfg('klingo_api_horarios', 'sim'); await cfg('klingo_api_marcar', 'sim'); await cfg('klingo_api_percentual', '100');
  const p = await ateOFim(await iniciar(nome), { motivo: 'exame', plano: 'Particular', confirmar: 'ok', antesDoHorario: async (x) => { await ofertar(x); } });
  const op = (await q(`select * from public.klingo_operacao where conversa_id = $1`, [p.c]))[0];
  return { p, op };
};
await caso('VOLTAR: durante "marcando" o chat NÃO deixa voltar (nada é desfeito e a operação segue uma só)', async () => {
  const { p, op } = await marcando('Voltar Bloqueado Teste');
  let erro = null; await anonimo();
  try { await rpc('chat_voltar', { p_conversa: p.c, p_token: p.t }); } catch (e) { erro = String(e.message).split('\n')[0]; } finally { await como(''); }
  const f = (await q(`select passo from public.conversa_fluxo where conversa_id = $1`, [p.c]))[0], n = (await um(`select count(*)::int n from public.klingo_operacao where conversa_id = $1`, [p.c])).n;
  return { ok: op && /não dá para voltar/i.test(erro || '') && f.passo === 'marcando' && n === 1, detalhe: `${erro} | passo=${f.passo} | operações=${n}` };
});
await caso('UMA OPERAÇÃO POR PEDIDO: mudar a chave do horário e criar de novo devolve a mesma operação (sem 2ª reserva)', async () => {
  const { p, op } = await marcando('Uma Operacao Teste');
  await db.query(`update public.pre_agendamentos set escolha_horario = jsonb_set(escolha_horario, '{0,klingo_chave}', '"2026-12-01|63|308|2|10:00"') where conversa_id = $1`, [p.c]);
  const r = await um(`select public.klingo_operacao_criar($1) id`, [p.c]);
  const n = (await um(`select count(*)::int n from public.klingo_operacao where conversa_id = $1`, [p.c])).n;
  return { ok: r.id === op.id && n === 1, detalhe: `mesma=${r.id === op.id}; operações=${n}` };
});
await caso('DIVERGÊNCIA 2+: nada marcado, o paciente é orientado a vir à CSI e a equipe é avisada (sem dado pessoal na nota)', async () => {
  const { p, op } = await marcando('Divergencia Dois Teste');
  await um(`select public.klingo_operacao_pegar($1)`, [op.id]);
  await um(`select public.klingo_operacao_concluir($1, 'falha', $2::jsonb)`, [op.id, JSON.stringify({ codigo: 'divergencia_2:nome,email' })]);
  const msgs = await q(`select texto, autor from public.mensagens where conversa_id = $1 order by id desc limit 6`, [p.c]);
  const pa = await pedidoDe(p.c), cv = await conversaDe(p.c);
  const aviso = msgs.find((m) => /CSI/.test(m.texto || '') && /documento com foto/.test(m.texto || ''));
  const nota = (await q(`select dados -> 'notas' as n from public.conversa_fluxo where conversa_id = $1 and dados::text ilike '%2 ou mais campos%'`, [p.c]))[0];
  return { ok: !!aviso && pa.status !== 'agendado' && cv.ia_ativa === false && !!nota && !/Divergencia Dois|11144477735/.test(JSON.stringify(nota)), detalhe: `aviso=${!!aviso}; status=${pa.status}; ia_ativa=${cv.ia_ativa}; nota=${!!nota}` };
});
await caso('DIVERGÊNCIA 1: nada marcado e a equipe recebe a nota com o NOME do campo para validar', async () => {
  const { p, op } = await marcando('Divergencia Um Teste');
  await um(`select public.klingo_operacao_pegar($1)`, [op.id]);
  await um(`select public.klingo_operacao_concluir($1, 'falha', $2::jsonb)`, [op.id, JSON.stringify({ codigo: 'divergencia_1:telefone' })]);
  const pa = await pedidoDe(p.c), cv = await conversaDe(p.c);
  const nota = (await q(`select dados -> 'notas' as n from public.conversa_fluxo where conversa_id = $1 and dados::text ilike '%Um campo do cadastro diverge%telefone%'`, [p.c]))[0];
  return { ok: pa.status !== 'agendado' && cv.ia_ativa === false && !!nota, detalhe: `status=${pa.status}; ia_ativa=${cv.ia_ativa}; nota=${!!nota}` };
});
await caso('DIVERGÊNCIA não é falha técnica: a autogestão em "sim" não recua por causa dela', async () => {
  await db.query(`delete from public.klingo_operacao`); await db.query(`delete from public.klingo_medida`);
  for (let i = 0; i < 5; i++) await db.query(`insert into public.klingo_operacao (tipo, conversa_id, chave_idem, estado, codigo, criado_em) select 'marcar', c.id, 'div-' || gen_random_uuid()::text, 'falha', 'divergencia_2:nome,mae', now() - interval '1 hour' from public.conversas c limit 1`);
  await cfg('klingo_autogestao', 'sim'); await cfg('klingo_auto', 'sim');
  const r = (await um(`select public.klingo_autogestao() r`)).r, m = await um(`select valor from public.config where chave = 'klingo_auto'`);
  await db.query(`delete from public.klingo_operacao where chave_idem like 'div-%'`); await cfg('klingo_auto', 'legado');
  return { ok: (r.acoes || []).length === 0 && m.valor === 'sim', detalhe: `acoes=${JSON.stringify(r.acoes)} valor=${m.valor}` };
});
await caso('NOME DA MÃE: com a API ligada o passo de identificação pede o nome da mãe; com o interruptor desligado, não', async () => {
  const { p } = await marcando('Mae Teste Paciente');
  const campos = async () => {
    await como('');
    await db.query(`select public.fluxo_perguntar($1, 'dados_ident', '')`, [p.c]);
    const m = (await q(`select opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [p.c]))[0];
    return ((m.opcoes && m.opcoes.campos) || []).map((c) => c.nome);
  };
  const ligado = await campos();
  await cfg('klingo_auto', 'nao'); const desligado = await campos(); await cfg('klingo_auto', 'legado');
  return { ok: ligado.includes('mae') && !desligado.includes('mae') && desligado.includes('cpf'), detalhe: `ligado=${ligado} | desligado=${desligado}` };
});


await caso('CONVÊNIO SEGUE O KLINGO: o que o Klingo não atende fica inativo, o que atende volta a ativo, e o paciente vê a mensagem de inativo ao escolher o convênio', async () => {
  await db.exec(`
    delete from public.convenio_config where operadora in ('CONV FORA TESTE', 'CONV VOLTOU TESTE', 'CONV MANUAL TESTE');
    insert into public.klingo_plano_map (operadora, convenio_id, plano_id, origem) values ('Conv Fora Teste', null, null, 'nao_atende'), ('Conv Voltou Teste', 7, 77, 'auto')
      on conflict (operadora) do update set plano_id = excluded.plano_id, origem = excluded.origem;
    insert into public.convenio_config (operadora, ativo, mensagem_inativo) values ('CONV VOLTOU TESTE', false, null), ('CONV MANUAL TESTE', true, 'texto da equipe') on conflict (operadora) do update set ativo = excluded.ativo;`);
  const r = (await um(`select public.convenio_seguir_klingo() r`)).r;
  const a = await q(`select operadora, ativo from public.convenio_config where operadora in ('CONV FORA TESTE', 'CONV VOLTOU TESTE', 'CONV MANUAL TESTE') order by 1`);
  const msg = (await um(`select public.convenio_msg('Conv Fora Teste', 'inativo') t`)).t;
  await cfg('convenio_seguir_klingo', 'nao'); await db.exec(`update public.convenio_config set ativo = false where operadora = 'CONV VOLTOU TESTE'`);
  const r2 = (await um(`select public.convenio_seguir_klingo() r`)).r, a2 = await um(`select ativo from public.convenio_config where operadora = 'CONV VOLTOU TESTE'`);
  await cfg('convenio_seguir_klingo', 'sim');
  const por = Object.fromEntries(a.map((x) => [x.operadora, x.ativo]));
  return { ok: r.desativados >= 1 && r.ativados >= 1 && por['CONV FORA TESTE'] === false && por['CONV VOLTOU TESTE'] === true && por['CONV MANUAL TESTE'] === true && /convenio_inativo|não estamos atendendo/.test(msg) && r2.ligada === false && a2.ativo === false,
    detalhe: `${JSON.stringify(r)} ${JSON.stringify(por)} | desligado: ${JSON.stringify(r2)} | msg=${msg}` };
});


// ---------------------------------------------------------------- 14. paciente conhecido confirma só o CPF; "não sou eu" e conferência velha pedem tudo de novo
const conhecido = async (nome, { idadeDias = 1 } = {}) => {
  const { p } = await marcando(nome);
  const pa = await pedidoDe(p.c), cpf = String(pa.paciente.cpf).replace(/\D/g, ''), nasc = pa.paciente.dt_nasc;
  await db.query(`insert into public.klingo_identidade (chave, cpf_hash, tipo, klingo_id, situacao, conferido_em) values (public.klingo_hash($1 || '|' || $2::text), public.klingo_hash($1), 'definitivo', 'P' || (floor(random() * 900000) + 100000)::int, 'confere', now() - make_interval(days => $3))
                  on conflict (chave) do update set situacao = 'confere', conferido_em = excluded.conferido_em`, [cpf, nasc, idadeDias]);
  // volta ao estado de "paciente que o chat já conhecia": dados guardados de antes, nada digitado nesta conversa
  await db.query(`update public.conversa_fluxo set dados = (dados - 'cpf_confirmado' - 'nao_sou_eu' - 'cpf_tentativas') || jsonb_build_object('digitado', (dados -> 'digitado') - 'cpf' - 'dt_nasc'), passo = 'plano' where conversa_id = $1`, [p.c]);
  return { p, cpf };
};
const proximo = async (c) => (await um(`select public.fluxo_proximo($1) r`, [c])).r;
await caso('PACIENTE CONHECIDO: o chat pede só o CPF; o CPF errado não passa; o certo segue para o plano', async () => {
  const { p, cpf } = await conhecido('Conhecido Cpf Teste');
  const a = await proximo(p.c);
  const errado = (await um(`select public.fluxo_aplicar($1, 'cpf_confirma', $2::jsonb) r`, [p.c, JSON.stringify({ cpf: '52998224725' })])).r;
  const certo = (await um(`select public.fluxo_aplicar($1, 'cpf_confirma', $2::jsonb) r`, [p.c, JSON.stringify({ cpf })])).r;
  const b = await proximo(p.c);
  return { ok: a === 'cpf_confirma' && errado.ok === false && /não confere/.test(errado.erro) && certo.ok !== false && b !== 'cpf_confirma' && b !== 'cpf_nasc', detalhe: `antes=${a}; errado=${errado.ok}; depois=${b}` };
});
await caso('NÃO SOU EU: apaga os dados guardados, não preenche nada e pede CPF, nascimento, nome, contato e mãe de novo', async () => {
  const { p } = await conhecido('Nao Sou Eu Teste');
  await um(`select public.fluxo_aplicar($1, 'cpf_confirma', $2::jsonb) r`, [p.c, JSON.stringify({ pular: true })]);
  const pa = await pedidoDe(p.c), a = await proximo(p.c);
  await como(''); await db.query(`select public.fluxo_perguntar($1, 'dados_ident', '')`, [p.c]);
  const m = (await q(`select opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [p.c]))[0];
  const campos = (m.opcoes.campos || []), cheio = campos.filter((c) => c.valor);
  return { ok: JSON.stringify(pa.paciente) === '{}' && a === 'cpf_nasc' && campos.some((c) => c.nome === 'mae') && cheio.length === 0, detalhe: `paciente=${JSON.stringify(pa.paciente)}; próximo=${a}; campos preenchidos=${cheio.length}` };
});
await caso('3 CPFs errados viram "não sou eu" (tudo de novo)', async () => {
  const { p } = await conhecido('Tres Erros Teste');
  for (let i = 0; i < 3; i++) await um(`select public.fluxo_aplicar($1, 'cpf_confirma', $2::jsonb) r`, [p.c, JSON.stringify({ cpf: '52998224725' })]);
  const pa = await pedidoDe(p.c);
  return { ok: JSON.stringify(pa.paciente) === '{}' && (await proximo(p.c)) === 'cpf_nasc', detalhe: JSON.stringify(pa.paciente) };
});
await caso('CONFERÊNCIA VELHA (mais de 90 dias): não vale só o CPF, o paciente digita tudo de novo', async () => {
  const { p } = await conhecido('Conferencia Velha Teste', { idadeDias: 120 });
  const a = await proximo(p.c), pa = await pedidoDe(p.c);
  return { ok: a === 'cpf_nasc' && JSON.stringify(pa.paciente) === '{}', detalhe: `próximo=${a}` };
});
await caso('API desligada: o paciente conhecido segue como sempre (não pede o CPF de novo)', async () => {
  const { p } = await conhecido('Api Desligada Teste');
  await cfg('klingo_auto', 'nao'); const a = await proximo(p.c); await cfg('klingo_auto', 'legado');
  return { ok: a !== 'cpf_confirma', detalhe: `próximo=${a}` };
});


// ---------------------------------------------------------------- 15. quadros: "Está tudo certo" depois da marcação automática encerra a conversa (só se ninguém da equipe entrou)
await caso('TUDO CERTO depois de agendado pela API: a conversa é encerrada (agendado/sistema); se a equipe já entrou, não é encerrada', async () => {
  const marcar = async (nome) => {
    const { p, op } = await marcando(nome);
    await um(`select public.klingo_operacao_pegar($1)`, [op.id]);
    await um(`select public.klingo_operacao_concluir($1, 'sucesso', $2::jsonb)`, [op.id, JSON.stringify({ voucher: { id: String(27000 + Math.floor(Math.random() * 900)), data: op.detalhe.data, hora: op.detalhe.hora, procedimento: 'RM JOELHO', unidade: 'CSI', profissional: 'EXEMPLO' } })]);
    return p;
  };
  const a = await marcar('Tudo Certo Teste'), b = await marcar('Tudo Certo Humano Teste');
  const AG = '00000000-0000-4000-8000-0000000000b9';
  await db.exec(`insert into auth.users (id, email) values ('${AG}', 'atendente-quadro@exemplo.invalid') on conflict do nothing;
                 insert into public.agentes (id, nome, email, papel, ativo) values ('${AG}', 'Atendente Quadro', 'atendente-quadro@exemplo.invalid', 'atendente', true) on conflict do nothing;`);
  await db.query(`update public.conversas set agente_id = $2, status = 'em_atendimento' where id = $1`, [b.c, AG]);
  const antesB = await conversaDe(b.c);
  await um(`select public.fluxo_pos_responder($1, 'fim')`, [a.c]); await um(`select public.fluxo_pos_responder($1, 'fim')`, [b.c]);
  const ca = await conversaDe(a.c), cb = await conversaDe(b.c);
  return { ok: ca.status === 'encerrada' && ca.motivo_encerramento === 'agendado' && ca.encerramento_origem === 'sistema' && cb.status !== 'encerrada', detalhe: `sem humano=${ca.status}/${ca.motivo_encerramento}/${ca.encerramento_origem}; com humano=${cb.status} (antes ${antesB.status}/${antesB.primeiro_humano_em ? 'humano' : 'sem humano'})` };
});


// ---------------------------------------------------------------- 16. só o que o Klingo libera: consultas e exames
await caso('SÓ O QUE O KLINGO LIBERA: desligado mostra tudo; ligado, no autoatendimento, a consulta some se a especialidade não é da API e o exame só aparece com horário no Klingo; fora do autoatendimento é tudo como antes', async () => {
  const { p } = await marcando('So Liberados Teste');
  const lib = async (proc, tipo) => (await um(`select public.klingo_liberado($1, $2, $3) r`, [p.c, proc, tipo])).r;
  await db.exec(`insert into public.klingo_especialidade (cbos, nome, procedimentos, liberada_api) values ('999991', 'TESTE LIBERADA', array[301], true), ('999992', 'TESTE NAO', array[302], false) on conflict (cbos) do update set procedimentos = excluded.procedimentos, liberada_api = excluded.liberada_api`);
  await cfg('klingo_so_liberados', 'nao'); const desligado = [await lib(301, 'consulta'), await lib(302, 'consulta'), await lib(201, 'exame')];
  await cfg('klingo_so_liberados', 'sim');
  const sem = await lib(201, 'exame');
  await um(`select public.klingo_sondagem_gravar(201, true)`); const com = await lib(201, 'exame');
  await um(`select public.klingo_sondagem_gravar(202, false)`); const vazio = await lib(202, 'exame');
  const ligado = [await lib(301, 'consulta'), await lib(302, 'consulta')];
  await db.exec(`update public.klingo_proc_api set com_horario_em = now() - interval '8 days' where procedimento_id = 201`); const velho = await lib(201, 'exame');
  await cfg('klingo_auto', 'nao'); const fora = [await lib(302, 'consulta'), await lib(202, 'exame')];
  await cfg('klingo_auto', 'legado'); await cfg('klingo_so_liberados', 'nao');
  return { ok: desligado.every(Boolean) && sem === false && com === true && vazio === false && ligado[0] === true && ligado[1] === false && velho === false && fora.every(Boolean),
    detalhe: `desligado=${desligado} | exame sem sondagem=${sem} com horário=${com} sem horário=${vazio} velho=${velho} | consultas ligado=${ligado} | fora do autoatendimento=${fora}` };
});
await caso('SONDAGEM DE EXAMES: pega os mais pedidos ainda não vistos, grava o resultado e só roda com o autoatendimento ligado', async () => {
  const antes = await q(`select public.klingo_exames_sondar(5) as id`);
  await um(`select public.klingo_sondagem_gravar(201, true)`);
  const dep = await q(`select public.klingo_exames_sondar(40) as id`);
  const g = await um(`select com_horario_em is not null as com, vazio_em is not null as vazio from public.klingo_proc_api where procedimento_id = 201`);
  await cfg('klingo_auto', 'nao'); const n0 = (await um(`select count(*)::int n from net.chamadas where url like '%klingo-sincronizar'`)).n; await um(`select public.klingo_sondar_disparar()`);
  const n1 = (await um(`select count(*)::int n from net.chamadas where url like '%klingo-sincronizar'`)).n; await cfg('klingo_auto', 'legado');
  return { ok: g.com === true && !dep.map((x) => x.id).includes(201) && n0 === n1, detalhe: `a sondar antes=${antes.length}, depois=${dep.length}; 201 gravado=${g.com}; chamadas com o interruptor desligado: ${n1 - n0}` };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
