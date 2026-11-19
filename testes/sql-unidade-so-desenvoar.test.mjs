// FLUXOGRAMA: entrada (clone da produção + supabase/unidade-so-desenvoar-whatsapp.sql) -> adulto pede consulta sem unidade autorizada -> chat_consultas devolve sem_unidade_autorizada e aviso -> chat_consulta_salvar recusa no servidor
//   -> criança em unidade autorizada (Desenvoar) continua listando e salvando a consulta como antes -> religar a CSI libera a consulta do adulto.
// Versão 1.0 — 19/11/2026 / Mudança: Implementação inicial (pacientes caindo na unidade errada: só a Desenvoar marca pelo chat, o resto volta para o WhatsApp)
// Dados: nenhum dado real; nomes e telefones inventados.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, anonimo } = ajudantes(db);
await caso('o clone da produção monta sem falhas', async () => ({ ok: falhas.length === 0, detalhe: `${falhas.length} falhas` }));

const D = 'DESENVOAR', C = 'CLÍNICA DE SAÚDE E IMAGEM - CSI';
await db.exec(`
  insert into public.unidade_config (chave, catalogo, rotulo, descricao, fluxo, instrucao, ordem, ativo) values
    ('desenvoar', '${D}', 'Desenvoar', 'x', 'pediatria', 'x', 1, true),
    ('csi', '${C}', 'CSI', 'x', 'exame_consulta', 'x', 2, false)
    on conflict (chave) do update set ativo = excluded.ativo, catalogo = excluded.catalogo, fluxo = excluded.fluxo;
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!'),
    ('marcacao_auto_desenvoar', 'sim'), ('marcacao_auto_csi', 'nao'), ('marcacao_auto_rmtc', 'nao')
    on conflict (chave) do update set valor = excluded.valor;
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values (301, 'CONSULTA PEDIATRIA', 'CONSULTAS', true, 20, ''), (302, 'CONSULTA ORTOPEDIA', 'CONSULTAS', true, 20, '');
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select p.id, p.nome, case when p.id = 301 then '${D}' else '${C}' end, 'CONSULTORIO 1', 'DR EXEMPLO ' || p.id, case when p.id = 301 then 'PEDIATRIA' else 'ORTOPEDIA' end, d, '08:00', '12:00', 30, current_date - 30, current_date + 300
    from public.catalogo_procedimento p cross join generate_series(0, 6) d where p.id in (301, 302);
`);
const sql = readFileSync(`${REPO}/supabase/unidade-so-desenvoar-whatsapp.sql`, 'utf8');
await caso('a migração aplica duas vezes sem erro (idempotente)', async () => { await db.exec(sql); await db.exec(sql); return { ok: true }; });

let nTel = 0;
const rpc = async (nome, args) => {
  const ks = Object.keys(args);
  const r = await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}`).join(', ')}) r`, ks.map((k) => args[k]));
  return r[0].r;
};
const CAMPO = (c) => (c.tipo === 'sexo' ? 'F' : c.tipo === 'data' ? '25/03/1980' : c.tipo === 'cpf' ? '111.444.777-35' : c.tipo === 'tel' ? '(71) 99999-0001' : c.tipo === 'email' ? 'maria@exemplo.invalid'
  : c.nome === 'nome' ? 'Maria Teste da Silva' : 'Texto de teste');
async function semRole() { await db.exec('reset role;'); }
// Abre a conversa e responde o motor até o passo do motivo; ali escolhe "Consulta" (é aí que o banco escolhe a unidade).
async function nova(tipo) {
  await anonimo();
  const r = await rpc('chat_iniciar', { p_nome: 'Maria Teste', p_telefone: '7198' + String(8000000 + ++nTel), p_email: 'maria@exemplo.invalid', p_aceite: true, p_paciente_tipo: tipo });
  const p = { c: r.conversa_id, t: r.token };
  let o = r.respostas.at(-1).opcoes;
  for (let i = 0; i < 8 && o; i++) {
    let resp;
    if (o.tipo === 'campos') { const v = {}; for (const cp of o.campos || []) v[cp.nome] = CAMPO(cp); resp = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify(v), p_texto: null }); }
    else if (o.tipo === 'escolha') {
      const item = o.passo === 'motivo' ? (o.itens || []).find((x) => x.valor === 'consulta') : (o.itens || [])[0];
      resp = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify(item.valor), p_texto: item.rotulo });
      if (o.passo === 'motivo') break;
    } else break;
    o = (resp.respostas || []).at(-1)?.opcoes || resp.opcoes;
  }
  return p;
}

// adulto: CSI desligada => nenhuma unidade de adulto ativa => conversa sem unidade
const adulto = await nova('proprio'); await semRole();
await caso('adulto pede consulta: a conversa fica sem unidade', async () => {
  await semRole();
  const u = (await um(`select unidade_inicial u from public.conversas where id = '${adulto.c}'`)).u;
  return { ok: u === null, detalhe: `unidade_inicial = ${u}` };
});
await caso('adulto sem unidade autorizada: lista vazia + sem_unidade_autorizada + aviso', async () => {
  await anonimo();
  const r = await rpc('chat_consultas', { p_conversa: adulto.c, p_token: adulto.t });
  return { ok: r.sem_unidade_autorizada === true && r.consultas.length === 0 && /só para Desenvoar/.test(r.aviso), detalhe: JSON.stringify(r) };
});
await caso('adulto: o servidor recusa salvar consulta (tela desatualizada)', async () => {
  await anonimo();
  let msg = '';
  try { await rpc('chat_consulta_salvar', { p_conversa: adulto.c, p_token: adulto.t, p_procedimento_id: 302 }); } catch (e) { msg = e.message; }
  await semRole();
  const n = (await um(`select count(*)::int n from public.pre_agendamento_itens where conversa_id = '${adulto.c}' and ativo`)).n;
  return { ok: /só para Desenvoar/.test(msg) && n === 0, detalhe: `${msg} | itens=${n}` };
});

// criança: consulta vai para a Desenvoar (autorizada) e segue como antes
const filho = await nova('filho'); await semRole();
await caso('criança pede consulta: unidade Desenvoar, lista só com a consulta de Desenvoar', async () => {
  await semRole();
  const u = (await um(`select unidade_inicial u from public.conversas where id = '${filho.c}'`)).u;
  await anonimo();
  const r = await rpc('chat_consultas', { p_conversa: filho.c, p_token: filho.t });
  return { ok: u === 'desenvoar' && !r.sem_unidade_autorizada && r.consultas.some((x) => x.id === 301) && !r.consultas.some((x) => x.id === 302), detalhe: `unidade=${u} ${JSON.stringify(r.consultas)}` };
});
await caso('criança: salvar a consulta da Desenvoar continua funcionando', async () => {
  await anonimo();
  const r = await rpc('chat_consulta_salvar', { p_conversa: filho.c, p_token: filho.t, p_procedimento_id: 301 });
  return { ok: r.ok === true, detalhe: JSON.stringify(r) };
});

// religar a CSI: o adulto passa a ter unidade e a consulta dela
await semRole();
await q(`update public.config set valor = 'sim' where chave = 'marcacao_auto_csi'`);
await q(`update public.unidade_config set ativo = true where chave = 'csi'`);
await semRole();
const adulto2 = await nova('proprio'); await semRole();
await caso('CSI religada: o adulto volta a listar e salvar a consulta', async () => {
  await anonimo();
  const r = await rpc('chat_consultas', { p_conversa: adulto2.c, p_token: adulto2.t });
  const s = await rpc('chat_consulta_salvar', { p_conversa: adulto2.c, p_token: adulto2.t, p_procedimento_id: 302 });
  return { ok: !r.sem_unidade_autorizada && r.consultas.some((x) => x.id === 302) && s.ok === true, detalhe: JSON.stringify(r.consultas) };
});

const falhou = resultados.filter((x) => !x).length;
console.log(falhou ? `\n${falhou} FALHA(S)` : `\nTodos os ${resultados.length} testes passaram.`);
await db.close?.();
process.exit(falhou ? 1 : 0);
