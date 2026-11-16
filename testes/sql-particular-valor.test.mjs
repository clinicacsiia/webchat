// FLUXOGRAMA: entrada (clone da produção + supabase/particular-valor-parte1..3.sql; um paciente de mentira percorre o chat pelas funções que o index.html chama; o Klingo é de mentira: o preço da API entra por klingo_preco_gravar e o teste faz o papel do executor)
//   -> validação (modo nao = igual a antes; modo sim + Particular = passo `valor`; convênio nunca passa por ele)
//   -> lógica (com preço: valor em destaque, "concordo" marca, "não quero" vai para a equipe sem cadastrar no Klingo; sem preço: a assistência informa e fica pendente; valor mudou entre ver e aceitar = pergunta de novo)
//   -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 16/11/2026 / Mudança: primeira versão (paciente Particular vê o valor antes de marcar).
// Dados: todos inventados aqui. Nenhuma linha vem da produção e nada é enviado ao Klingo de verdade.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { await como('').catch(() => {}); registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um, como, anonimo } = ajudantes(db);
await db.exec(`insert into vault.secrets_tbl (name, secret) values ('klingo_hash_sal', 'sal-de-teste'), ('klingo_interno_segredo', 'interno-de-teste')`);
registrar('o retrato da produção monta inteiro', falhas.length === 0, `${falhas.length} falhas`);

const UNIDADE = 'CLÍNICA DE SAÚDE E IMAGEM - CSI', TESTE = '71900000001';
await db.exec(`
  insert into public.config (chave, valor) values ('ia_segredo', 'segredo-de-teste'), ('motor', 'fluxo'), ('nome_empresa', 'Clínica de Teste'), ('boas_vindas', 'Olá!'), ('reabrir_dias', '2'),
    ('klingo_auto', 'sim'), ('klingo_api_horarios', 'teste'), ('klingo_api_marcar', 'teste'), ('klingo_api_pre_cadastro', 'teste'), ('klingo_api_telefones_teste', '${TESTE}'), ('klingo_api_percentual', '100'),
    ('klingo_funcoes_base', 'https://funcoes.exemplo.invalid/') on conflict (chave) do update set valor = excluded.valor;
  insert into public.catalogo_regiao (codigo, nome, padrao, tem_lado, grupo, ordem) values ('joelho', 'Joelho', 'JOELHO', true, 'perna', 1);
  insert into public.catalogo_procedimento (id, nome, classe, ativo, demanda_90d, busca) values (201, 'RESSONANCIA MAGNETICA DO JOELHO (UNILATERAL)', 'RESSONANCIA MAGNETICA', true, 9, ''), (202, 'ULTRASSONOGRAFIA DE ABDOME TOTAL', 'ULTRASSONOGRAFIA', true, 7, '');
  insert into public.catalogo_agenda (procedimento_id, procedimento, unidade, local, profissional, especialidade, dia_num, hora_ini, hora_fim, duracao_min, vig_ini, vig_fim)
    select 201, 'RM JOELHO', '${UNIDADE}', 'RESSONANCIA', 'DRA EXEMPLO IMAGEM', 'RADIOLOGIA', d, '08:00', '12:00', 30, current_date - 30, current_date + 300 from generate_series(0, 6) d;
  insert into public.klingo_plano_map (operadora, convenio_id, plano_id, origem) values ('Particular', 1, 1, 'auto') on conflict do nothing;
  insert into public.klingo_convenio (plano_id, convenio_id, convenio, plano, convenio_norm, padrao) values (1, 1, 'Particular', 'PARTICULAR', 'PARTICULAR', true) on conflict do nothing;
`);
const dia = (n) => new Date(Date.now() + n * 864e5).toLocaleString('sv-SE', { timeZone: 'America/Bahia' }).slice(0, 10);
const CAMPO = (c) => (c.tipo === 'sexo' ? 'F' : c.tipo === 'data' ? '25/03/1980' : c.tipo === 'cpf' ? '111.444.777-35' : c.tipo === 'tel' ? '(71) 99999-0001' : c.tipo === 'email' ? 'maria@exemplo.invalid'
  : c.tipo === 'cep' ? '40000-000' : c.tipo === 'uf' ? 'BA' : c.nome === 'nome' ? 'Maria Teste da Silva' : c.nome === 'mae' ? 'Ana Teste da Silva' : c.nome === 'numero' ? '10' : 'Texto de teste');
let nTel = 0, nNasc = 0;
const telefone = () => '7198' + String(4000000 + ++nTel);
const lista = new Set([TESTE]);
const rpc = async (nome, args) => {
  const ks = Object.keys(args), ehJson = (v) => v !== null && typeof v === 'object';
  const r = await q(`select public.${nome}(${ks.map((k, i) => `${k} => $${i + 1}${ehJson(args[k]) ? '::jsonb' : ''}`).join(', ')}) r`, ks.map((k) => (ehJson(args[k]) ? JSON.stringify(args[k]) : args[k])));
  return r[0].r;
};
const cfg = async (chave, valor) => { await como(''); return db.query(`insert into public.config (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`, [chave, valor]); };
const nascUnico = () => { nNasc++; return `${String(1 + (nNasc % 27)).padStart(2, '0')}/${String(1 + (nNasc % 11)).padStart(2, '0')}/${1950 + nNasc}`; };
// Anda com o paciente de mentira. parar(o) devolve true para parar ANTES de responder aquela pergunta. Depois do calendário usa uma oferta da API de mentira.
async function andar(p, parar, nasc) {
  for (let i = 0; i < 40; i++) {
    const o = p.ult.opcoes;
    if (!o || ['acompanhar', 'nova', 'marcando', 'marcado'].includes(o.tipo) || parar(o, p)) return p;
    await anonimo(); let x;
    if (o.tipo === 'escolha') { const it = (o.itens || []).find((i) => i.valor === (p.esc || {})[o.passo]) || (o.itens || [])[0]; x = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: JSON.stringify(it.valor), p_texto: it.rotulo }); }
    else if (o.tipo === 'campos') { const v = {}; for (const cp of o.campos || []) v[cp.nome] = cp.tipo === 'data' && nasc ? nasc : CAMPO(cp); x = await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: o.passo, p_valor: v, p_texto: null }); }
    else if (o.tipo === 'busca_exame' || o.tipo === 'pedido_exames') { const ex = await rpc('chat_exames', { p_conversa: p.c, p_token: p.t, p_modalidade: 'RM', p_regiao: 'joelho' }); x = await rpc('chat_pedido_enviar', { p_conversa: p.c, p_token: p.t, p_itens: [{ modalidade: 'RM', regiao: 'joelho', lado: 'D', procedimento_id: ex[0].id }] }); }
    else if (o.tipo === 'calendario') {
      const d = dia(3), chave = `${d}|63|308|2|09:00`;
      await como('');   // oferta e registro da consulta são do sistema (service_role), não do paciente
      await db.query(`select public.klingo_oferta_gravar_v2($1, 201, 1, $2::jsonb, false, true)`, [p.c, JSON.stringify([{ chave, data: d, hora: '09:00', profissional: 'DRA EXEMPLO IMAGEM', unidade: UNIDADE }])]);
      await db.query(`select public.klingo_consulta_registrar($1, 'teste', 'exame', 201, 1, 'ok_com_horarios', 200, 1, 1, 0, 1, 500, null)`, [p.c]);
      await anonimo(); x = await rpc('chat_horario_escolher', { p_conversa: p.c, p_token: p.t, p_grupo: 1, p_data: d, p_hora: '09:00', p_unidade: UNIDADE });
      x = { respostas: (await rpc('chat_listar', { p_conversa: p.c, p_token: p.t, p_apos: p.ult.id })).mensagens || [] };
    } else throw new Error(`tipo não tratado: ${o.tipo}`);
    const ag = ((x && x.respostas) || []).filter((m) => m.autor === 'agente');
    if (!ag.length) throw new Error(`sem resposta depois de ${o.passo}`);
    p.ult = ag.at(-1);
  }
  throw new Error('não terminou em 40 passos');
}
async function novo(nasc = nascUnico(), tel = telefone()) {
  lista.add(tel); await cfg('klingo_api_telefones_teste', [...lista].join(','));
  await anonimo();
  const r = await rpc('chat_iniciar', { p_nome: 'Maria Teste da Silva', p_telefone: tel, p_email: 'maria@exemplo.invalid', p_aceite: true, p_paciente_tipo: 'proprio' });
  const p = { c: r.conversa_id, t: r.token, tel, nasc, ult: r.respostas.at(-1) };
  return p;
}
const ateMarcando = async (p) => { await andar(p, (o) => false, p.nasc); await como(''); return p; };   // anda até o fim; se marcar, o último passo é "marcando"

// ---------------------------------------------------------------- aplica as 3 partes (duas vezes: tem de ser idempotente)
const partes = ['particular-valor-parte1-base.sql', 'particular-valor-parte2-roteiro.sql', 'particular-valor-parte3-telas.sql'].map((f) => readFileSync(`${REPO}/supabase/${f}`, 'utf8'));
await caso('as 3 partes de particular-valor aplicam duas vezes sem erro (idempotente)', async () => { for (const s of [...partes, ...partes]) await db.exec(s); return { ok: true }; });
const preco = (id, valor, plano = 1) => db.query(`select public.klingo_preco_gravar($1::jsonb)`, [JSON.stringify([{ id, plano, valor }])]);
const limparPreco = () => db.query(`delete from public.klingo_preco_api`);
const ateValor = async (p) => { await andar(p, (o) => o.passo === 'valor', p.nasc); await como(''); return p; };
const novoAteValor = async () => ateValor(await novo());
const ops = async (c) => (await um(`select count(*)::int n from public.klingo_operacao where conversa_id = $1`, [c])).n;
const fala = async (p, passo, valor, texto) => { await anonimo(); try { return await rpc('chat_responder', { p_conversa: p.c, p_token: p.t, p_passo: passo, p_valor: valor === null ? null : JSON.stringify(valor), p_texto: texto ?? null }); } finally { await como(''); } };
const digita = async (p, texto) => { await anonimo(); try { return (await q(`select public.chat_enviar($1::uuid, $2, $3) r`, [p.c, p.t, texto]))[0].r; } finally { await como(''); } };
const ultimo = async (p) => (await q(`select texto, opcoes from public.mensagens where conversa_id = $1 and autor = 'agente' order by id desc limit 1`, [p.c]))[0];
const fluxoDe = (c) => um(`select passo, dados from public.conversa_fluxo where conversa_id = $1`, [c]);
const conversaDe = (c) => um(`select status, ia_ativa, triagem_resumo from public.conversas where id = $1`, [c]);
const pedidoDe2 = (c) => um(`select status, escolha_horario from public.pre_agendamentos where conversa_id = $1`, [c]);

// ---------------------------------------------------------------- 1. modo nao = comportamento de antes
await caso('modo nao (como nasce): Particular vai de "confirmar" direto para a marcação, sem passo valor', async () => {
  const p = await ateMarcando(await novo());
  const m = (await um(`select public.particular_valor_ativo($1) a`, [p.c])).a;
  return { ok: p.ult.opcoes?.tipo === 'marcando' && m === false && (await ops(p.c)) === 1, detalhe: `último: ${p.ult.opcoes?.tipo}; operações ${await ops(p.c)}` };
});

// ---------------------------------------------------------------- 2. modo sim, com preço
await db.query(`insert into public.config (chave, valor) values ('particular_valor_modo', 'sim') on conflict (chave) do update set valor = 'sim'`);
await limparPreco(); await preco(201, 580);
let aceita;
await caso('com preço da API: depois do "Está tudo certo" aparece o passo valor, com o valor em destaque e dois botões; NADA foi cadastrado ainda', async () => {
  aceita = await novoAteValor();
  const u = await ultimo(aceita), o = u.opcoes;
  return { ok: o.passo === 'valor' && o.tipo === 'escolha' && o.destaque.valor === 'R$ 580,00' && o.destaque.titulo.includes('Particular') && o.itens.map((i) => i.valor).join() === 'sim,nao'
    && /R\$ 580,00/.test(u.texto) && (await ops(aceita.c)) === 0 && (await conversaDe(aceita.c)).ia_ativa === true, detalhe: `${o.destaque?.valor}; ${o.itens.map((i) => i.rotulo).join(' | ')}` };
});
await caso('o paciente concorda: o valor aceito fica gravado e a marcação automática segue (1 operação)', async () => {
  await fala(aceita, 'valor', 'sim', 'Concordo com o valor e quero marcar');
  const f = await fluxoDe(aceita.c);
  return { ok: f.passo === 'marcando' && f.dados.valor_resp.resp === 'aceito' && Number(f.dados.valor_resp.total) === 580 && (f.dados.notas || []).some((n) => /ACEITOU o valor Particular de R\$ 580,00/.test(n)) && (await ops(aceita.c)) === 1, detalhe: `passo ${f.passo}; ${f.dados.valor_resp.resp}` };
});
await caso('o paciente recusa: vai para o atendente com o aviso "VALOR RECUSADO" e NADA é cadastrado no Klingo', async () => {
  const p = await novoAteValor();
  await fala(p, 'valor', 'nao', 'Não quero marcar por causa do valor');
  const cv = await conversaDe(p.c), f = await fluxoDe(p.c), pa = await pedidoDe2(p.c), u = await ultimo(p);
  const pode = (await um(`select public.klingo_pode_marcar($1) r`, [p.c])).r;
  return { ok: cv.ia_ativa === false && /VALOR RECUSADO/.test(cv.triagem_resumo) && /R\$ 580,00/.test(cv.triagem_resumo) && f.dados.valor_resp.resp === 'recusado' && (await ops(p.c)) === 0
    && pa.status !== 'agendado' && /não vou marcar agora/.test(u.texto) && pode.motivo === 'valor_nao_aceito', detalhe: `${cv.triagem_resumo.slice(0, 80).replace(/\n/g, ' ')}…; trava: ${pode.motivo}` };
});
await caso('texto livre "sim" / "não" no passo valor também vale', async () => {
  const a = await novoAteValor(), b = await novoAteValor();
  await digita(a, 'sim'); await digita(b, 'não, está caro');
  const fa = await fluxoDe(a.c), fb = await fluxoDe(b.c);
  return { ok: fa.dados.valor_resp.resp === 'aceito' && fb.dados.valor_resp.resp === 'recusado', detalhe: `${fa.dados.valor_resp?.resp} / ${fb.dados.valor_resp?.resp}` };
});
await caso('o valor mudou entre ver e aceitar: não aceita o valor antigo, mostra o novo e pergunta de novo', async () => {
  const p = await novoAteValor();
  await preco(201, 600);
  const r = await fala(p, 'valor', 'sim', 'Concordo');
  const f = await fluxoDe(p.c), u = await ultimo(p);
  await preco(201, 580);
  return { ok: f.passo === 'valor' && f.dados.valor_resp === undefined && u.opcoes.destaque.valor === 'R$ 600,00' && /atualizado/.test(u.texto) && (await ops(p.c)) === 0, detalhe: `${u.opcoes.destaque?.valor}; passo ${f.passo}` };
});

// ---------------------------------------------------------------- 3. sem preço
let semPreco;
await caso('sem preço na API: avisa que a assistência passa o valor e pergunta se o paciente quer saber (sem valor em destaque)', async () => {
  await limparPreco(); await preco(201, null);   // a API respondeu sem valor
  semPreco = await novoAteValor();
  const u = await ultimo(semPreco);
  return { ok: u.opcoes.passo === 'valor' && u.opcoes.destaque === undefined && u.opcoes.itens.map((i) => i.rotulo).join('|') === 'Sim, quero saber o valor|Não preciso do valor agora' && (await ops(semPreco.c)) === 0, detalhe: u.opcoes.itens.map((i) => i.rotulo).join(' | ') };
});
await caso('sem preço e o paciente quer o valor: fica PENDENTE para a equipe responder; não cadastra no Klingo', async () => {
  await fala(semPreco, 'valor', 'sim', 'Sim, quero saber o valor');
  const cv = await conversaDe(semPreco.c), pa = await pedidoDe2(semPreco.c), f = await fluxoDe(semPreco.c), u = await ultimo(semPreco);
  return { ok: cv.ia_ativa === false && pa.status === 'pronto' && /PENDENTE/.test(JSON.stringify(f.dados.notas)) && /PENDENTE/.test(cv.triagem_resumo) && (await ops(semPreco.c)) === 0 && /informar o valor aqui na conversa/.test(u.texto), detalhe: `pedido ${pa.status}` };
});
await caso('sem preço e o paciente não pediu o valor: pedido segue para a equipe marcar; não cadastra no Klingo', async () => {
  const p = await novoAteValor();
  await fala(p, 'valor', 'nao', 'Não preciso do valor agora');
  const pa = await pedidoDe2(p.c), cv = await conversaDe(p.c);
  return { ok: pa.status === 'pronto' && cv.ia_ativa === false && (await ops(p.c)) === 0, detalhe: `pedido ${pa.status}` };
});
await caso('o preço velho (mais de 12 h) não vale: o chat trata como "sem preço"', async () => {
  await limparPreco(); await preco(201, 580); await db.query(`update public.klingo_preco_api set consultado_em = now() - interval '13 hours'`);
  const p = await novoAteValor();
  const u = await ultimo(p);
  await limparPreco(); await preco(201, 580);
  return { ok: u.opcoes.passo === 'valor' && u.opcoes.destaque === undefined, detalhe: 'sem destaque' };
});

// ---------------------------------------------------------------- 4. vários exames, lado, convênio, remarcação, chave
await caso('o valor soma os exames; se UM não tem preço, o conjunto inteiro vai para a equipe; "os dois lados" de exame unilateral cobra 2x', async () => {
  const p = await novo(); await como('');
  await db.query(`insert into public.pre_agendamentos (conversa_id) values ($1) on conflict (conversa_id) do nothing`, [p.c]);
  await db.query(`update public.pre_agendamentos set tipo = 'exame', plano = 'Particular' where conversa_id = $1`, [p.c]);
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento) values ($1, 'RM', 'JOELHO', 'Joelho', 'D', 201, 'RM JOELHO'), ($1, 'US', 'ABDOME', 'Abdome', 'D', 202, 'US ABDOME')`, [p.c]);
  await limparPreco(); await preco(201, 580);
  const so1 = (await um(`select public.particular_valor_obter($1) r`, [p.c])).r;
  await preco(202, 150);
  const dois = (await um(`select public.particular_valor_obter($1) r`, [p.c])).r;
  await db.query(`update public.pre_agendamento_itens set lado = 'A' where conversa_id = $1 and procedimento_id = 201`, [p.c]);
  const ambos = (await um(`select public.particular_valor_obter($1) r`, [p.c])).r;
  await limparPreco(); await preco(201, 580);
  return { ok: so1.completo === false && so1.faltando.length === 1 && dois.completo === true && Number(dois.total) === 730 && dois.itens.length === 2 && ambos.completo === true && Number(ambos.total) === 1310, detalhe: `1 sem preço: ${so1.completo}; soma ${dois.total}; dois lados ${ambos.total}` };
});
await caso('plano de convênio nunca ativa o passo valor', async () => {
  const p = await novo(); await como('');
  await db.query(`insert into public.pre_agendamentos (conversa_id) values ($1) on conflict (conversa_id) do nothing`, [p.c]);
  await db.query(`update public.pre_agendamentos set plano = 'Amil' where conversa_id = $1`, [p.c]);
  const a = (await um(`select public.particular_valor_ativo($1) a, public.particular_valor_obter($1) o`, [p.c]));
  return { ok: a.a === false && a.o.particular === false, detalhe: `ativo=${a.a}` };
});
await caso('mudou o exame depois de aceitar: a resposta antiga deixa de valer e a marcação automática é travada', async () => {
  const antes = (await um(`select public.particular_valor_assinatura($1) a`, [aceita.c])).a;
  await db.query(`update public.pre_agendamento_itens set ativo = false where conversa_id = $1`, [aceita.c]);
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento) values ($1, 'US', 'ABDOME', 'Abdome', 'D', 202, 'US ABDOME')`, [aceita.c]);
  const depois = (await um(`select public.particular_valor_assinatura($1) a`, [aceita.c])).a;
  const pode = (await um(`select public.klingo_pode_marcar($1) r`, [aceita.c])).r;
  return { ok: antes !== depois && pode.ok === false && pode.motivo === 'valor_nao_aceito', detalhe: `trava: ${pode.motivo}` };
});
await caso('remarcação de um agendamento que já existe não pede valor de novo', async () => {
  const p = await novo(); await como('');
  await db.query(`insert into public.pre_agendamentos (conversa_id) values ($1) on conflict (conversa_id) do nothing`, [p.c]);
  await db.query(`update public.pre_agendamentos set plano = 'Particular' where conversa_id = $1`, [p.c]);
  const a = (await um(`select public.particular_valor_ativo($1) a`, [p.c])).a;
  await db.query(`update public.conversa_fluxo set dados = dados || '{"remarcando": {"voucher": "1"}}'::jsonb where conversa_id = $1`, [p.c]);
  const b = (await um(`select public.particular_valor_ativo($1) a`, [p.c])).a;
  return { ok: a === true && b === false, detalhe: `normal ${a}; remarcando ${b}` };
});
await caso('voltar ao modo nao desliga na hora (quem estaria no passo valor segue direto)', async () => {
  const p = await novoAteValor();
  await db.query(`update public.config set valor = 'nao' where chave = 'particular_valor_modo'`);
  const prox = (await um(`select public.fluxo_proximo($1) p`, [p.c])).p;
  await db.query(`update public.config set valor = 'sim' where chave = 'particular_valor_modo'`);
  const prox2 = (await um(`select public.fluxo_proximo($1) p`, [p.c])).p;
  return { ok: prox === 'pronto' && prox2 === 'valor', detalhe: `nao: ${prox}; sim: ${prox2}` };
});

// ---------------------------------------------------------------- 5. a consulta ao Klingo
await caso('o banco pede o preço à API (uma chamada só, só com o segredo do cofre, sem dado de paciente); com preço fresco não chama de novo', async () => {
  await limparPreco(); await db.query(`delete from net.chamadas where url like '%klingo-preco'`);
  const p = await novo(); await como('');
  await db.query(`insert into public.pre_agendamentos (conversa_id) values ($1) on conflict (conversa_id) do nothing`, [p.c]);
  await db.query(`insert into public.pre_agendamento_itens (conversa_id, modalidade, regiao, regiao_nome, lado, procedimento_id, procedimento) values ($1, 'RM', 'JOELHO', 'Joelho', 'D', 201, 'RM JOELHO')`, [p.c]);
  await db.query(`update public.pre_agendamentos set plano = 'Particular' where conversa_id = $1`, [p.c]);
  await um(`select public.particular_valor_disparar($1)`, [p.c]);
  const ch = await q(`select url, body, headers from net.chamadas where url like '%klingo-preco'`);
  await preco(201, 580);
  await um(`select public.particular_valor_disparar($1)`, [p.c]);
  const ch2 = await q(`select 1 from net.chamadas where url like '%klingo-preco'`);
  const pii = JSON.stringify(ch[0]?.body ?? {}).match(/Maria|conversa|cpf/i);
  return { ok: ch.length === 1 && ch[0].body.acao === 'preco' && ch[0].body.plano === 1 && JSON.stringify(ch[0].body.ids) === '[201]' && ch[0].headers['x-klingo-segredo'] === 'interno-de-teste' && !pii && ch2.length === 1, detalhe: `${JSON.stringify(ch[0]?.body)}; chamadas depois do preço fresco: ${ch2.length}` };
});
await caso('klingo_preco_gravar guarda valor zero, negativo ou texto como "sem preço" e ignora id inválido', async () => {
  await limparPreco();
  const n = (await um(`select public.klingo_preco_gravar($1::jsonb) n`, [JSON.stringify([{ id: 1, plano: 1, valor: 0 }, { id: 2, plano: 1, valor: -4 }, { id: 3, plano: 1, valor: 'abc' }, { id: 4, plano: 1, valor: 90.5 }, { id: 'x', plano: 1, valor: 10 }])])).n;
  const l = await q(`select procedimento_id, valor from public.klingo_preco_api order by 1`);
  await limparPreco();
  return { ok: n === 4 && l.length === 4 && l.filter((x) => x.valor !== null).length === 1 && Number(l[3].valor) === 90.5, detalhe: JSON.stringify(l) };
});

// ---------------------------------------------------------------- 6. permissões
await caso('as funções e a tabela do preço não são chamáveis pelo público nem pela equipe logada', async () => {
  const fns = ['particular_plano_id()', 'klingo_preco_gravar(jsonb)', 'particular_valor_ativo(uuid)', 'particular_valor_assinatura(uuid)', 'particular_valor_obter(uuid)', 'particular_valor_disparar(uuid)'];
  const r = [];
  for (const f of fns) { const x = await um(`select has_function_privilege('anon', 'public.${f}', 'execute') a, has_function_privilege('authenticated', 'public.${f}', 'execute') b, has_function_privilege('service_role', 'public.${f}', 'execute') s`); r.push(!x.a && !x.b && x.s); }
  const t = await um(`select has_table_privilege('anon', 'public.klingo_preco_api', 'select') a, has_table_privilege('authenticated', 'public.klingo_preco_api', 'select') b, (select relrowsecurity from pg_class where relname = 'klingo_preco_api') rls`);
  return { ok: r.every(Boolean) && !t.a && !t.b && t.rls === true, detalhe: `funções ok=${r.every(Boolean)}; tabela anon=${t.a} auth=${t.b} rls=${t.rls}` };
});

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok} de ${resultados.length} verificações passaram.`);
process.exit(ok === resultados.length ? 0 : 1);
