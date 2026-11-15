// FLUXOGRAMA: entrada (clone da produção + supabase/dados-ident-sem-repetir.sql; conversa aberta pelo motor REAL: chat_iniciar, chat_responder, fluxo_perguntar, fluxo_aplicar) -> 1ª mensagem (CPF/nascimento pedidos UMA vez) -> cpf_nasc respondido -> dados_ident (só nome e sexo; sem CPF, nascimento e mãe) -> respostas aceitas/recusadas
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial (o chat não pede de novo CPF, nascimento e nome da mãe)
// Dados: todos inventados neste arquivo (CPF 529.982.247-25 é CPF de exemplo que passa na conferência). Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo } = ajudantes(db);
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));

const sql = readFileSync(`${REPO}/supabase/dados-ident-sem-repetir.sql`, 'utf8');
await caso('dados-ident-sem-repetir.sql aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

// o clone não traz os textos do motor (só as chaves): semeia os reais, de textos-enxutos.sql e klingo-auto-parte4a
await q(`insert into public.fluxo_texto (chave, texto, descricao) values
  ('ola_cpf_proprio', 'Olá, {nome}! Para começar, informe o seu CPF e a data de nascimento. Eles ficam protegidos e servem só para conferir quem é o paciente.', 't'),
  ('cpf_nasc', 'Para localizar o seu cadastro, preciso do CPF e da data de nascimento{de_quem}. Eles ficam protegidos e servem só para conferir quem é o paciente.', 't'),
  ('dados_erro', 'Confira, por favor: {erros}.', 't'),
  ('dados_ident', 'Agora os dados para o cadastro{de_quem}. Primeiro, a identificação:', 't')
  on conflict (chave) do update set texto = excluded.texto`);
const CPF = '529.982.247-25';
let tel = 71990000000;
const iniciar = async () => {
  await q(`update public.conversas set criado_em = criado_em - interval '2 hours'`);   // o chat limita 5 conversas por hora por celular
  await anonimo();
  try {
    const r = (await q(`select public.chat_iniciar(p_nome => $1, p_telefone => $2, p_email => $3, p_aceite => true, p_paciente_tipo => 'proprio') r`, ['Alisson Teste da Silva', String(tel++), 'a@exemplo.invalid']))[0].r;
    return { c: r.conversa_id, t: r.token, primeira: r.respostas.at(-1) };
  } finally { await db.exec('reset role'); }
};
const responder = async (c, passo, valor) => {
  await anonimo();
  try { return (await q(`select public.chat_responder(p_conversa => $1, p_token => $2, p_passo => $3, p_valor => $4::jsonb, p_texto => 'Enviado.') r`, [c.c, c.t, passo, JSON.stringify(valor)]))[0].r; }
  finally { await db.exec('reset role'); }
};
const ultimaPergunta = async (c) => um(`select texto, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' and opcoes is not null order by id desc limit 1`, [c.c]);
const campos = (m) => (m.opcoes?.campos || []).map((x) => x.nome);
const quantas = (txt, trecho) => txt.split(trecho).length - 1;

let c;
await caso('1ª mensagem: pede CPF e nascimento UMA vez só (sem o segundo texto repetido) e o formulário tem CPF e nascimento', async () => {
  c = await iniciar();
  const p = c.primeira;
  const pedidos = quantas(p.texto, 'Eles ficam protegidos');
  return { ok: p.opcoes?.passo === 'cpf_nasc' && pedidos === 1 && !p.texto.includes('Para localizar o seu cadastro') && p.texto.includes('Para começar') && campos(p).join() === 'cpf,dt_nasc', detalhe: `pedidos=${pedidos} | ${p.texto.replace(/\n/g, ' / ').slice(0, 140)}` };
});

await caso('depois do CPF e nascimento o motor segue para o plano (não pede nada de novo)', async () => {
  const r = await responder(c, 'cpf_nasc', { cpf: CPF, dt_nasc: '11/05/1997' });
  const u = await ultimaPergunta(c);
  return { ok: !!r.respostas && ['plano', 'horario', 'motivo', 'exame', 'consulta', 'atalho', 'identidade'].includes(u.opcoes?.passo), detalhe: u.opcoes?.passo };
});

await caso('erro no CPF: o texto de erro aparece junto da pergunta (prefixo normal continua funcionando)', async () => {
  const c2 = await iniciar();
  const r = await responder(c2, 'cpf_nasc', { cpf: '111.111.111-11', dt_nasc: '11/05/1997' });
  const u = await ultimaPergunta(c2);
  return { ok: u.opcoes?.passo === 'cpf_nasc' && /CPF/.test(u.texto) && quantas(u.texto, 'Para localizar o seu cadastro') === 1, detalhe: u.texto.replace(/\n/g, ' / ').slice(0, 160) };
});

// dados_ident: força o passo, como o motor faria depois do plano e do horário
const irParaDadosIdent = async (conv, extra = '') => {
  await q(`update public.conversa_fluxo set dados = dados || jsonb_build_object('digitado', coalesce(dados->'digitado','{}'::jsonb) || '{}'::jsonb) ${extra} where conversa_id = $1`, [conv.c]);
  await q(`select public.fluxo_perguntar($1::uuid, 'dados_ident', null)`, [conv.c]);
  return ultimaPergunta(conv);
};

await caso('dados_ident: só NOME e SEXO (sem CPF, sem nascimento, sem nome da mãe), também com a API do Klingo ligada', async () => {
  const u = await irParaDadosIdent(c);
  const ligado = await q(`select public.klingo_ativo($1::uuid, 'klingo_api_marcar') a`, [c.c]);
  return { ok: u.opcoes?.passo === 'dados_ident' && campos(u).join() === 'nome,sexo', detalhe: `campos=${campos(u).join()} klingo_marcar=${ligado[0].a}` };
});

await caso('dados_ident com a API do Klingo LIGADA (marcar = sim): continua só nome e sexo', async () => {
  await q(`update public.config set valor = 'sim' where chave in ('klingo_auto','klingo_api_marcar','klingo_api_pre_cadastro','klingo_api_percentual')`);
  await q(`insert into public.config (chave, valor) select k, 'sim' from unnest(array['klingo_auto','klingo_api_marcar']) k where not exists (select 1 from public.config where chave = k)`);
  const u = await irParaDadosIdent(c);
  const ligado = (await q(`select public.klingo_ativo($1::uuid, 'klingo_api_marcar') a`, [c.c]))[0].a;
  return { ok: campos(u).join() === 'nome,sexo', detalhe: `campos=${campos(u).join()} klingo_marcar=${ligado}` };
});

await caso('responder só nome e sexo é aceito (CPF e nascimento já estão no pedido) e o pedido guarda os 4 dados', async () => {
  const r = await responder(c, 'dados_ident', { nome: 'Alisson Oliveira da Cruz', sexo: 'M' });
  const pa = await um(`select paciente from public.pre_agendamentos where conversa_id = $1`, [c.c]);
  const f = await um(`select dados from public.conversa_fluxo where conversa_id = $1`, [c.c]);
  return { ok: r.ok !== false && f.dados.g_ident === true && !!pa.paciente.cpf && !!pa.paciente.dt_nasc && pa.paciente.sexo === 'M' && pa.paciente.nome === 'Alisson Oliveira da Cruz' && !pa.paciente.mae, detalhe: JSON.stringify({ g_ident: f.dados.g_ident, cpf: !!pa.paciente.cpf, nasc: pa.paciente.dt_nasc, sexo: pa.paciente.sexo, mae: pa.paciente.mae ?? null }) };
});

await caso('sem nome ou sem sexo continua sendo recusado, dizendo o que falta', async () => {
  const c3 = await iniciar(); await responder(c3, 'cpf_nasc', { cpf: CPF, dt_nasc: '11/05/1997' });
  await q(`select public.fluxo_perguntar($1::uuid, 'dados_ident', null)`, [c3.c]);
  const r = await q(`select public.fluxo_aplicar($1::uuid, 'dados_ident', '{"nome":"Alisson Oliveira da Cruz"}'::jsonb) r`, [c3.c]);
  const r2 = await q(`select public.fluxo_aplicar($1::uuid, 'dados_ident', '{"sexo":"M"}'::jsonb) r`, [c3.c]);
  return { ok: r[0].r.ok === false && /sexo/.test(r[0].r.erro) && r2[0].r.ok === false && /nome/.test(r2[0].r.erro), detalhe: `${r[0].r.erro?.slice(0, 80)} | ${r2[0].r.erro?.slice(0, 80)}` };
});

await caso('quem NÃO tem CPF/nascimento no pedido e manda só nome e sexo é recusado (a trava continua valendo)', async () => {
  const c4 = await iniciar();   // nunca respondeu o cpf_nasc
  const r = await q(`select public.fluxo_aplicar($1::uuid, 'dados_ident', '{"nome":"Alisson Oliveira da Cruz","sexo":"M"}'::jsonb) r`, [c4.c]);
  return { ok: r[0].r.ok === false && /CPF/.test(r[0].r.erro) && /nascimento/.test(r[0].r.erro), detalhe: r[0].r.erro?.slice(0, 120) };
});

await caso('formulário ANTIGO (já aberto na tela de alguém) com CPF, nascimento e mãe ainda é aceito e grava tudo', async () => {
  const c5 = await iniciar();
  const r = await q(`select public.fluxo_aplicar($1::uuid, 'dados_ident', $2::jsonb) r`, [c5.c, JSON.stringify({ nome: 'Maria da Silva Souza', sexo: 'F', dt_nasc: '03/02/1990', cpf: CPF, mae: 'Ana da Silva Souza' })]);
  const pa = await um(`select paciente from public.pre_agendamentos where conversa_id = $1`, [c5.c]);
  return { ok: r[0].r.ok === true && pa.paciente.mae === 'Ana da Silva Souza' && pa.paciente.dt_nasc === '1990-02-03', detalhe: JSON.stringify(r[0].r).slice(0, 100) };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
