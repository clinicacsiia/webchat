// FLUXOGRAMA: entrada (o retrato da produção + supabase/familia-agendamento.sql montados num Postgres embutido) -> validação (cada regra da família é exercitada com pessoas e aparelhos INVENTADOS: limite de aparelhos,
//   nível 2 que nunca desce, convite de uso único, espera de 24 h com aviso, aparelho desligado, fila lenta com no máximo 3 por vez, cache, linha do tempo) -> lógica (as funções rodam como service_role; anon e logado de painel não chegam às tabelas)
//   -> saída (PASS/FAIL; código 1 se algo falhar)
// Versão 1.0 — 13/11/2026 / Mudança: primeira versão (família, aparelhos lembrados e acompanhamento). Nenhuma linha vem da produção.
import { readFileSync } from 'node:fs';
import { criarBancoProducao, ajudantes, REPO } from './banco-producao.mjs';

const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const caso = async (nome, fn) => { try { const r = await fn(); registrar(nome, r.ok, r.detalhe); } catch (e) { registrar(nome, false, `exceção: ${String(e.message).split('\n')[0]}`); } };

const { db, falhas } = await criarBancoProducao();
const { q, um } = ajudantes(db);
let aplicou = true;
try { await db.exec(readFileSync(`${REPO}/supabase/familia-agendamento.sql`, 'utf8')); } catch (e) { aplicou = false; registrar('aplicar familia-agendamento.sql no clone da produção', false, String(e.message).split('\n')[0]); }
registrar('o retrato monta inteiro e o arquivo novo aplica sem erro (e aplica de novo sem erro)', falhas.length === 0 && aplicou && await db.exec(readFileSync(`${REPO}/supabase/familia-agendamento.sql`, 'utf8')).then(() => true, () => false));

const H = (n) => 'h'.repeat(40) + String(n).padStart(4, '0');
const aparelho = async (n) => (await um(`select public.familia_aparelho_criar($1, $2) as id`, [H(n), `Celular ${n}`])).id;
const pessoa = async (nome, n) => (await um(`insert into public.familia_pessoa (chave, primeiro_nome, dados_cifrados) values ($1, $2, 'cifrado') returning id`, [`chave-${n}`, nome])).id;
const vinc = async (a, p, papel = 'responsavel', porta = 'cpf', nivel = 1, lib = null) => (await um(`select public.familia_vincular($1, $2, $3, $4, $5, $6) as r`, [a, p, papel, porta, nivel, lib])).r;

const ana = await pessoa('Ana', 1), joao = await pessoa('João', 2), carla = await pessoa('Carla', 3);
const celCarla = await aparelho(1), celPedro = await aparelho(2), celVo = await aparelho(3), celTio = await aparelho(4);

await caso('a mãe liga o celular a si mesma e aos dois filhos; o celular devolve as três pessoas, ela primeiro', async () => {
  await vinc(celCarla, carla, 'proprio'); await vinc(celCarla, ana); await vinc(celCarla, joao);
  const r = (await um(`select public.familia_aparelho_ler($1) as r`, [H(1)])).r;
  return { ok: r.ok && r.pessoas.length === 3 && r.pessoas[0].nome === 'Carla' && r.pessoas[0].papel === 'proprio' && r.pessoas.every((p) => p.nivel === 1), detalhe: JSON.stringify(r.pessoas.map((p) => p.nome + ':' + p.papel)) };
});
await caso('o pai liga o dele aos mesmos filhos (dois responsáveis) e cada celular só vê o que é seu', async () => {
  await vinc(celPedro, ana); await vinc(celPedro, joao);
  const r = (await um(`select public.familia_aparelho_ler($1) as r`, [H(2)])).r;
  return { ok: r.pessoas.length === 2 && !r.pessoas.some((p) => p.nome === 'Carla'), detalhe: JSON.stringify(r.pessoas.map((p) => p.nome)) };
});
await caso('o terceiro responsável entra; o quarto é barrado com o limite 3 ("máximo entre aspas")', async () => {
  const a = await vinc(celVo, ana), b = await vinc(celTio, ana);
  return { ok: a.ok === true && b.ok === false && b.motivo === 'limite_aparelhos' && b.limite === 3, detalhe: JSON.stringify(b) };
});
await caso('a recepção sobe o limite em config e o quarto entra; ligar o mesmo celular de novo não conta duas vezes', async () => {
  await db.query(`update public.config set valor = '4' where chave = 'familia_max_aparelhos'`);
  const b = await vinc(celTio, ana), c = await vinc(celTio, ana);
  await db.query(`update public.config set valor = '3' where chave = 'familia_max_aparelhos'`);
  return { ok: b.ok === true && c.ok === true && (await um(`select count(*)::int n from public.familia_vinculo where pessoa_id = $1`, [ana])).n === 4, detalhe: JSON.stringify([b, c]) };
});
await caso('celular desligado deixa de contar no limite e some ("desconhecido"); ninguém liga um celular desligado', async () => {
  await db.query(`select public.familia_aparelho_desligar($1)`, [celTio]);
  const r = (await um(`select public.familia_aparelho_ler($1) as r`, [H(4)])).r;
  const v = await vinc(celTio, joao);
  const vo = await um(`select public.familia_vincular($1, $2, 'responsavel', 'cpf', 1, null) as r`, [celVo, joao]);
  return { ok: r.ok === false && r.motivo === 'desconhecido' && v.ok === false && v.motivo === 'aparelho_desligado' && vo.r.ok === true, detalhe: JSON.stringify([r, v]) };
});
await caso('código de aparelho que não existe e aparelho parado há 13 meses voltam como "desconhecido" e "dormindo"', async () => {
  const x = (await um(`select public.familia_aparelho_ler($1) as r`, ['x'.repeat(44)])).r;
  await db.query(`update public.familia_aparelho set ultimo_uso = now() - interval '13 months' where id = $1`, [celPedro]);
  const d = (await um(`select public.familia_aparelho_ler($1) as r`, [H(2)])).r;
  await db.query(`update public.familia_aparelho set ultimo_uso = now() where id = $1`, [celPedro]);
  return { ok: x.motivo === 'desconhecido' && d.motivo === 'dormindo', detalhe: JSON.stringify([x, d]) };
});
await caso('o nível 2 nunca é rebaixado por uma nova ligação de nível 1', async () => {
  await vinc(celCarla, carla, 'proprio', 'balcao', 2, new Date().toISOString()); await vinc(celCarla, carla, 'proprio', 'cpf', 1);
  const r = (await um(`select public.familia_aparelho_ler($1) as r`, [H(1)])).r;
  return { ok: r.pessoas.find((p) => p.nome === 'Carla').nivel === 2, detalhe: JSON.stringify(r.pessoas.map((p) => p.nome + ':' + p.nivel)) };
});

// ---------------------------------------------------------------- convite
const lia = await pessoa('Lia', 11), davi = await pessoa('Davi', 12);
await vinc(celCarla, lia, 'responsavel', 'balcao', 2, new Date().toISOString()); await vinc(celCarla, davi, 'responsavel', 'balcao', 2, new Date().toISOString()); await vinc(celPedro, lia);
await caso('só quem já abre o laudo da pessoa gera convite; celular de nível 1 é recusado', async () => {
  const a = (await um(`select public.familia_convite_criar($1, $2, $3) as r`, [celPedro, [lia], 'c'.repeat(64)])).r;
  return { ok: a.ok === false && a.motivo === 'sem_acesso_ao_laudo', detalhe: JSON.stringify(a) };
});
await caso('a mãe (nível 2 nos filhos) convida; a avó usa o código uma vez e passa a abrir laudo; segunda vez e código vencido falham', async () => {
  const avo = await aparelho(5);
  const c = (await um(`select public.familia_convite_criar($1, $2, $3) as r`, [celCarla, [lia, davi], 'd'.repeat(64)])).r;
  const u = (await um(`select public.familia_convite_usar($1, $2) as r`, ['d'.repeat(64), avo])).r;
  const outro = await aparelho(6);
  const u2 = (await um(`select public.familia_convite_usar($1, $2) as r`, ['d'.repeat(64), outro])).r;
  const lido = (await um(`select public.familia_aparelho_ler($1) as r`, [H(5)])).r;
  await um(`select public.familia_convite_criar($1, $2, $3) as r`, [celCarla, [lia], 'e'.repeat(64)]);
  await db.query(`update public.familia_convite set expira_em = now() - interval '1 minute' where codigo_hash = $1`, ['e'.repeat(64)]);
  const venc = (await um(`select public.familia_convite_usar($1, $2) as r`, ['e'.repeat(64), outro])).r;
  const mesmo = (await um(`select public.familia_convite_criar($1, $2, $3) as r`, [celCarla, [lia], 'f'.repeat(64)])).r, ms = (await um(`select public.familia_convite_usar($1, $2) as r`, ['f'.repeat(64), celCarla])).r;
  return { ok: c.ok && u.ok && u.ligadas === 2 && u2.motivo === 'convite_invalido' && venc.motivo === 'convite_invalido' && ms.motivo === 'mesmo_aparelho' && lido.pessoas.some((p) => p.nome === 'Lia' && p.nivel === 2 && p.papel === 'responsavel') && lido.pessoas.some((p) => p.nome === 'Davi' && p.nivel === 2), detalhe: JSON.stringify({ u, u2, venc, ms }) };
});

// ---------------------------------------------------------------- "eu sei todos os dados"
await caso('sem outro celular com acesso ao laudo, quem sabe todos os dados abre na hora e não gera aviso', async () => {
  const sozinha = await pessoa('Beatriz', 10), c1 = await aparelho(20);
  const r = (await um(`select public.familia_pedir_por_dados($1, $2, 'proprio') as r`, [c1, sozinha])).r;
  const avisos = (await um(`select count(*)::int n from public.familia_aviso where pessoa_id = $1`, [sozinha])).n;
  const lido = (await um(`select public.familia_aparelho_ler($1) as r`, [H(20)])).r;
  return { ok: r.ok && r.imediato === true && avisos === 0 && lido.pessoas[0].nivel === 2, detalhe: JSON.stringify(r) };
});
const tia = await aparelho(30);
await caso('com outro celular com acesso, o pedido espera 24 h, abre aviso para o celular da mãe e o laudo continua fechado (nível 1 até lá)', async () => {
  const r = (await um(`select public.familia_pedir_por_dados($1, $2, 'responsavel') as r`, [tia, davi])).r;
  const lido = (await um(`select public.familia_aparelho_ler($1) as r`, [H(30)])).r;
  const avisos = (await um(`select public.familia_avisos($1) as r`, [celCarla])).r;
  const d = (await um(`select (select liberado_em from public.familia_vinculo where aparelho_id = $1 and pessoa_id = $2) - now() as espera`, [tia, davi])).espera;
  return { ok: r.ok && r.imediato === false && lido.pessoas[0].nivel === 1 && lido.pessoas[0].espera_ate && avisos.length === 1 && avisos[0].pessoa === 'Davi' && parseInt(String(d), 10) >= 23, detalhe: JSON.stringify({ r, d }) };
});
await caso('pedir duas vezes não abre dois avisos; quem não tem acesso ao laudo não vê nem responde o aviso', async () => {
  await db.query(`select public.familia_pedir_por_dados($1, $2, 'responsavel')`, [tia, davi]);
  const n = (await um(`select count(*)::int n from public.familia_aviso where pessoa_id = $1 and resposta is null`, [davi])).n;
  const vistoPor = (await um(`select public.familia_avisos($1) as r`, [tia])).r;
  const id = (await um(`select id from public.familia_aviso where pessoa_id = $1`, [davi])).id;
  const r = (await um(`select public.familia_aviso_responder($1, $2, true) as r`, [tia, id])).r;
  return { ok: n === 1 && vistoPor.length === 0 && r.ok === false, detalhe: JSON.stringify(r) };
});
await caso('a mãe toca em "Liberar": o laudo abre na hora para a tia; em "Bloquear", o pedido some', async () => {
  const id = (await um(`select id from public.familia_aviso where pessoa_id = $1`, [davi])).id;
  const lib = (await um(`select public.familia_aviso_responder($1, $2, true) as r`, [celCarla, id])).r;
  const lido = (await um(`select public.familia_aparelho_ler($1) as r`, [H(30)])).r;
  const t2 = await aparelho(31);
  const noa = await pessoa('Noa', 13); await vinc(celCarla, noa, 'responsavel', 'balcao', 2, new Date().toISOString());
  await db.query(`select public.familia_pedir_por_dados($1, $2, 'responsavel')`, [t2, noa]);
  const id2 = (await um(`select id from public.familia_aviso where aparelho_pedinte = $1`, [t2])).id;
  const blo = (await um(`select public.familia_aviso_responder($1, $2, false) as r`, [celCarla, id2])).r;
  const resta = (await um(`select count(*)::int n from public.familia_vinculo where aparelho_id = $1`, [t2])).n;
  return { ok: lib.ok && lido.pessoas[0].nivel === 2 && !lido.pessoas[0].espera_ate && blo.ok && resta === 0, detalhe: JSON.stringify({ lib, blo, resta }) };
});

// ---------------------------------------------------------------- acompanhamento
const grav = (o) => um(`select public.familia_marcacao_gravar($1::jsonb) as r`, [JSON.stringify(o)]);
const base = { pessoa_id: ana, procedimento: 'CONSULTA', profissional: 'DRA TESTE', unidade: 'DESENVOAR', data: '2026-11-20', hora: '09:40' };
await caso('a marcação nasce com o primeiro passo; cada mudança de estado soma um passo; repetir o mesmo estado não duplica', async () => {
  await grav({ ...base, voucher_id: '26700' }); await grav({ ...base, voucher_id: '26700', status: 'confirmado' }); await grav({ ...base, voucher_id: '26700', status: 'confirmado' }); await grav({ ...base, voucher_id: '26700', status: 'atendido' });
  const e = await q(`select tipo from public.familia_evento where voucher_id = '26700' order by id`);
  return { ok: e.map((x) => x.tipo).join() === 'agendado,confirmado,atendido', detalhe: e.map((x) => x.tipo).join() };
});
await caso('o laudo pronto não volta atrás; a linha do tempo de um celular só traz as pessoas dele, com os passos em ordem', async () => {
  await grav({ ...base, voucher_id: '26700', status: 'laudo_pronto' }); await grav({ ...base, voucher_id: '26700', status: 'atendido' });
  await grav({ ...base, pessoa_id: carla, voucher_id: '26701', procedimento: 'ULTRASSOM' });
  const doPai = (await um(`select public.familia_acompanhar($1) as r`, [celPedro])).r, daMae = (await um(`select public.familia_acompanhar($1) as r`, [celCarla])).r;
  const m = doPai.find((x) => x.voucher === '26700');
  return { ok: doPai.length === 1 && daMae.length === 2 && m.status === 'laudo_pronto' && m.laudo_pronto_em && m.eventos.map((x) => x.tipo).join() === 'agendado,confirmado,atendido,laudo_pronto', detalhe: `${doPai.length}/${daMae.length}` };
});
await caso('voucher que não é número é recusado (nada de texto solto no banco)', async () => {
  try { await grav({ ...base, voucher_id: "1'; drop" }); return { ok: false }; } catch (e) { return { ok: /voucher_invalido/.test(e.message) }; }
});
await caso('a previsão do laudo aprende: com menos de 5 casos só diz a amostra; com 5 ou mais dá a mediana', async () => {
  const antes = (await um(`select public.familia_previsao_laudo('RESSONANCIA') as r`)).r;
  for (let i = 0; i < 5; i++) {
    const v = String(30000 + i);
    await grav({ ...base, voucher_id: v, procedimento: 'RESSONANCIA', status: 'atendido' }); await grav({ ...base, voucher_id: v, procedimento: 'RESSONANCIA', status: 'laudo_pronto' });
    await db.query(`update public.familia_evento set criado_em = now() - interval '5 days' where voucher_id = $1 and tipo = 'atendido'`, [v]);
    await db.query(`update public.familia_evento set criado_em = now() - interval '${i} days' where voucher_id = $1 and tipo = 'laudo_pronto'`, [v]);
  }
  const depois = (await um(`select public.familia_previsao_laudo('RESSONANCIA') as r`)).r;
  return { ok: antes.amostra === 0 && antes.mediana_dias === undefined && depois.amostra === 5 && Number(depois.mediana_dias) === 3 && Number(depois.p80_dias) >= 3, detalhe: JSON.stringify(depois) };
});

// ---------------------------------------------------------------- fila lenta, cache, popularidade
await caso('a fila entrega no máximo 3 por vez, quem espera na tela (prioridade 1) vai primeiro, e a pré-carga (9) fica por último', async () => {
  for (let i = 0; i < 5; i++) await db.query(`select public.agenda_fila_pedir($1, '{}'::jsonb, 9)`, [`pre:${i}`]);
  await db.query(`select public.agenda_fila_pedir('urgente', '{}'::jsonb, 1)`);
  const pega = await q(`select chave from public.agenda_fila_pegar(10)`);
  return { ok: pega.length === 3 && pega[0].chave === 'urgente', detalhe: pega.map((x) => x.chave).join() };
});
await caso('falha tenta de novo com espera crescente e desiste na 6ª; pedir de novo reativa e sobe a prioridade', async () => {
  await db.query(`delete from public.agenda_fila`);
  const id = (await um(`select public.agenda_fila_pedir('x', '{}'::jsonb, 9) as id`)).id;
  let estado;
  for (let i = 1; i <= 6; i++) {
    await db.query(`update public.agenda_fila set proximo_em = now() - interval '1 second' where id = $1`, [id]);
    await q(`select * from public.agenda_fila_pegar(3)`);
    await db.query(`select public.agenda_fila_fim($1, false, 'limite')`, [id]);
    estado = await um(`select estado, tentativas, proximo_em > now() as adiado from public.agenda_fila where id = $1`, [id]);
    if (i < 6 && !(estado.estado === 'espera' && estado.adiado)) return { ok: false, detalhe: `volta ${i}: ${JSON.stringify(estado)}` };
  }
  await db.query(`select public.agenda_fila_pedir('x', '{}'::jsonb, 2)`);
  const de_novo = await um(`select estado, prioridade from public.agenda_fila where id = $1`, [id]);
  return { ok: estado.estado === 'erro' && de_novo.estado === 'espera' && de_novo.prioridade === 2, detalhe: JSON.stringify({ estado, de_novo }) };
});
await caso('tarefa feita com "refazer em" volta para a espera; o cache devolve o que gravou e avisa quando venceu', async () => {
  await db.query(`delete from public.agenda_fila`);
  const id = (await um(`select public.agenda_fila_pedir('y', '{}'::jsonb, 5) as id`)).id;
  await q(`select * from public.agenda_fila_pegar(1)`); await db.query(`select public.agenda_fila_fim($1, true, null, interval '10 minutes')`, [id]);
  const f = await um(`select estado, proximo_em > now() as adiado from public.agenda_fila where id = $1`, [id]);
  await db.query(`select public.agenda_cache_gravar('h:1', '{"a":1}'::jsonb, 60)`);
  const c = (await um(`select public.agenda_cache_ler('h:1') as r`)).r;
  await db.query(`update public.agenda_cache set valido_ate = now() - interval '1 second' where chave = 'h:1'`);
  const v = (await um(`select public.agenda_cache_ler('h:1') as r`)).r, nada = (await um(`select public.agenda_cache_ler('nao') as r`)).r;
  return { ok: f.estado === 'espera' && f.adiado && c.dados.a === 1 && c.vencido === false && v.vencido === true && nada === null, detalhe: JSON.stringify({ f, c, v }) };
});
await caso('a popularidade soma os horários marcados por médico (bloqueios não contam) e ignora o que é antigo', async () => {
  await db.query(`insert into public.agenda_ocupacao (inicio, profissional, unidade, fonte, qtd) values
    (now() - interval '3 days', 'DRA POPULAR', 'CSI', 'marcada', 1), (now() - interval '4 days', 'DRA POPULAR', 'CSI', 'marcada', 1), (now() - interval '5 days', 'DR RARO', 'CSI', 'marcada', 1),
    (now() - interval '3 days', 'DR BLOQUEADO', 'CSI', 'bloqueada', 1), (now() - interval '300 days', 'DR ANTIGO', 'CSI', 'marcada', 1)`);
  const p = (await um(`select public.agenda_popularidade(90) as r`)).r;
  return { ok: p[0].profissional === 'DRA POPULAR' && p[0].total === 2 && p.length === 2 && !p.some((x) => /BLOQ|ANTIGO/.test(x.profissional)), detalhe: JSON.stringify(p) };
});

// ---------------------------------------------------------------- pessoa
await caso('guardar a mesma pessoa duas vezes não duplica (mesma chave), renova plano e id do Klingo; ler exige vínculo do aparelho', async () => {
  const a = (await um(`select public.familia_pessoa_guardar($1::jsonb) as r`, [JSON.stringify({ chave: 'k-teo', par_hash: 'par-1', primeiro_nome: 'Teo', dados_cifrados: 'c1', cpf_de: 'responsavel', klingo_id: '', plano_id: '1', plano_nome: 'PARTICULAR' })])).r;
  const b = (await um(`select public.familia_pessoa_guardar($1::jsonb) as r`, [JSON.stringify({ chave: 'k-teo', par_hash: 'par-1', primeiro_nome: 'Teo', dados_cifrados: 'c2', klingo_id: '7960', plano_id: '14', plano_nome: 'AMIL' })])).r;
  const n = (await um(`select count(*)::int n, max(dados_cifrados) d, max(klingo_id) k, max(plano_id) pl from public.familia_pessoa where chave = 'k-teo'`));
  const sem = (await um(`select public.familia_pessoa_ler($1, $2) as r`, [celCarla, a.id])).r;
  await vinc(celCarla, a.id, 'responsavel', 'cpf', 1);
  const com = (await um(`select public.familia_pessoa_ler($1, $2) as r`, [celCarla, a.id])).r;
  const par = (await um(`select public.familia_pessoa_por_par('par-1') as r`)).r;
  return { ok: a.novo === true && b.novo === false && a.id === b.id && n.n === 1 && n.d === 'c1' && n.k === '7960' && n.pl === 14 && sem === null && com.nivel === 1 && com.cpf_de === 'responsavel' && par.length === 1, detalhe: JSON.stringify({ n, com }) };
});
await caso('os planos em uso vêm do mais comum para o menos comum', async () => {
  const p = (await um(`select public.familia_planos_em_uso() as r`)).r;
  return { ok: Array.isArray(p) && (await um(`select count(*)::int n from public.familia_pessoa where plano_id is not null`)).n >= 0 && p.every((x) => Number.isInteger(x)), detalhe: JSON.stringify(p) };
});
await caso('o histórico conta os médicos já usados (sem cancelados) e as marcações abertas ignoram o que já acabou', async () => {
  const h = (await um(`select public.familia_historico($1) as r`, [[ana, carla]])).r;
  const ab = (await um(`select public.familia_marcacoes_abertas($1) as r`, [ana])).r;
  const ativos = (await um(`select public.familia_pessoas_ativas(60) as r`)).r;
  return { ok: h[0].profissional === 'DRA TESTE' && h.every((x) => x.total >= 1) && ab.length === 0 && Array.isArray(ativos) && ativos.length > 0, detalhe: JSON.stringify({ h, ab }) };
});

await caso('o registro de abertura de laudo guarda só quem, qual e quando, e passa a recusar a partir da 6ª abertura no mesmo minuto', async () => {
  const r = [];
  for (let i = 0; i < 6; i++) r.push((await um(`select public.familia_acesso_registrar($1, $2, $3) as r`, [celCarla, ana, String(26700 + i)])).r);
  const gravou = await q(`select * from public.familia_acesso where aparelho_id = $1`, [celCarla]);
  return { ok: r.slice(0, 5).every((x) => x.ok) && r[5].ok === false && r[5].motivo === 'devagar' && gravou.length === 5 && !('conteudo' in gravou[0]), detalhe: JSON.stringify(r[5]) };
});

// ---------------------------------------------------------------- segurança
await caso('visitante (anon) e logado do painel não leem as tabelas da família nem executam as funções', async () => {
  const falhou = async (papel, sql) => { await db.exec(`reset role; set role ${papel};`); try { await db.query(sql); return false; } catch { return true; } finally { await db.exec(`reset role;`); } };
  const r = [await falhou('anon', `select * from public.familia_pessoa`), await falhou('authenticated', `select * from public.familia_aparelho`),
    await falhou('anon', `select public.familia_aparelho_ler('x')`), await falhou('authenticated', `select public.familia_acompanhar('${celCarla}')`), await falhou('authenticated', `select * from public.agenda_fila_pegar(1)`)];
  return { ok: r.every(Boolean), detalhe: r.join() };
});
await caso('nenhuma função da família devolve CPF, nascimento ou nome completo (a leitura do aparelho só traz primeiro nome e plano)', async () => {
  const lido = JSON.stringify((await um(`select public.familia_aparelho_ler($1) as r`, [H(1)])).r) + JSON.stringify((await um(`select public.familia_acompanhar($1) as r`, [celCarla])).r);
  return { ok: !/dados_cifrados|"cpf"\s*:|nascimento/i.test(lido), detalhe: lido.length + ' bytes' };
});

const falhasN = resultados.filter((x) => !x).length;
console.log(`\n${resultados.length - falhasN}/${resultados.length} verificações passaram.`);
process.exit(falhasN ? 1 : 0);
