// FLUXOGRAMA: entrada (simulacao/indi.mjs + o dia de demonstração simulacao/agenda.json + os exemplos externa.json e decisao.json; nada de paciente) -> validação (cada assunto tem as 4 partes da fala, o texto é escapado, o alvo cai dentro do dia e dentro da unidade) -> lógica (recalcula aqui, por outro caminho, o minuto do pico de fila, a hora da falta e do atraso e compara com o que a Indi escolheu) -> saída (relatório do node:test)
// Versão 1.0 — 15/11/2026 / Mudança: criação (a personagem Indi)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as E from '../simulacao/engine.mjs';
import * as A from '../simulacao/analise.mjs';
import * as I from '../simulacao/indi.mjs';

const json = async (c) => JSON.parse(await readFile(new URL('../simulacao/' + c, import.meta.url), 'utf8'));
const agenda = await json('agenda.json'), externa = await json('examples/externa.json'), decisao = await json('examples/decisao.json');
const dia = agenda[Object.keys(agenda)[0]];
const plan = E.initialPlan(dia);
const model = E.simulate(E.makeRoster(dia), plan, E.seeds[0], true, 10);
const stages = A.buildStages(externa, { waiting: 5, level: 'serious', text: 'Espera P90 simulada de 50 min; 5 pessoa(s) em fila.', units: { csi1: 5 } });
const recs = [{ level: 'alta', title: 'Mais uma estação em CSI 1', text: 'A fila do ultrassom passa de 40 minutos às 10h.', unit: 'csi1' }];
const pontos = A.pontosDeAtencao({ stages, decisao, recs });
const lista = I.assuntos({ pontos, cartoes: A.cartoesDoPainel(decisao) });
const por = (id) => lista.find((a) => a.id === id);
const FILA = ['reception', 'prepQueue', 'examQueue'];

test('assuntos: os 4 números do painel primeiro, depois os problemas, e todos têm id único', () => {
  assert.deepEqual(lista.slice(0, 4).map((a) => a.id), ['cartao-entraram', 'cartao-agendaram', 'cartao-novas', 'cartao-faltas']);
  assert(lista.length > 8);
  assert.equal(new Set(lista.map((a) => a.id)).size, lista.length);
  assert(lista.slice(4).every((a) => a.grupo === 'problema'));
  assert.deepEqual(I.assuntos({}), []);
});

test('fala: cada assunto explica em 4 partes, sem texto vazio nem "undefined"', () => {
  for (const a of lista) {
    const partes = I.explicar(a);
    assert.deepEqual(partes.map((p) => p.rotulo), ['O que é', 'Como está agora', 'Por que importa', 'O que eu faria']);
    for (const p of partes) assert(p.texto.length > 10 && !/undefined|null|NaN/.test(p.texto), a.id + ' / ' + p.rotulo + ': ' + p.texto);
    assert(!/undefined/.test(I.falaHtml(a)));
  }
  // os problemas conhecidos têm explicação própria, não a genérica
  for (const id of ['etapa-chat', 'etapa-pedidos', 'etapa-confirmar', 'etapa-clinica', 'etapa-resultado']) assert.notEqual(I.tipoDoPonto({ id }), 'generico');
});

test('texto escapado: título e frase com HTML não viram HTML', () => {
  const ruim = [{ id: 'etapa-chat', grupo: 'problema', tipo: 'etapa-chat', titulo: '<img src=x onerror=alert(1)>', nivel: 'critical', texto: '<b>oi</b>' }];
  const html = I.falaHtml(ruim[0]) + I.chipsHtml(ruim);
  assert(!/<img|<b>/.test(html));
  assert.match(html, /▲/); assert.match(html, /Crítico/);
  assert.match(I.chipsHtml([]), /Ainda não carreguei/);
});

test('o tipo de cada indicador decide como a Indi mostra o problema', () => {
  assert.equal(I.modoDoTipo('etapa-clinica'), 'fila'); assert.equal(I.modoDoTipo('sim'), 'fila');
  assert.equal(I.modoDoTipo('cartao-faltas'), 'falta'); assert.equal(I.modoDoTipo('etapa-confirmar'), 'falta');
  assert.equal(I.modoDoTipo('etapa-hoje'), 'atraso'); assert.equal(I.modoDoTipo('etapa-pedidos'), 'vazio');
  for (const t of ['etapa-chat', 'etapa-resultado', 'cartao-entraram', 'cartao-agendaram', 'cartao-novas', 'dest-semresposta']) assert.equal(I.modoDoTipo(t), 'sem_hora');
});

test('unidade do assunto: aceita nome ("CSI 1") e chave (csi2), escolhe a de maior valor e ignora o resto', () => {
  assert.equal(I.unidadeDoAssunto({ unidades: { 'CSI 1': 3, csi2: 9, ped: 1 } }), 'csi2');
  assert.equal(I.unidadeDoAssunto({ unidades: { 'CSI Pediatria': 2 } }), 'ped');
  assert.equal(I.unidadeDoAssunto({ unidades: { 'Outra': 5 } }), null);
  assert.equal(I.unidadeDoAssunto({ unidades: { csi1: 0 } }), null);
  assert.equal(I.unidadeDoAssunto({}), null);
});

test('fila: a Indi vai ao minuto em que a unidade tem MAIS gente esperando (conferido por contagem independente) e ao setor da maior fila', () => {
  const alvo = I.alvoDoProblema(por('etapa-clinica'), model, plan);
  assert.equal(alvo.tipo, 'fila'); assert.equal(alvo.exata, true);
  const conta = (u, t) => model.jobs.filter((j) => j.unit === u && !j.absent && FILA.includes(E.stage(j, t))).length;
  const n = conta(alvo.unidade, alvo.minuto);
  assert(n > 0);
  for (const u of Object.keys(E.units)) for (let t = E.OPEN; t <= 1200; t++) assert(conta(u, t) <= n, `${u} ${E.clock(t)} tem ${conta(u, t)} > ${n}`);
  assert(alvo.minuto >= E.OPEN && alvo.inicio >= E.OPEN && alvo.inicio <= alvo.minuto && alvo.minuto - alvo.inicio <= 20);
  assert(plan[alvo.unidade + ':' + alvo.setor] !== undefined, 'o setor existe no plano da unidade');
  assert.match(alvo.legenda, new RegExp(String(n)));
  assert.match(alvo.local, /· /);
});

test('fila: quando o assunto aponta uma unidade, a visita é nela', () => {
  for (const unidade of ['csi1', 'csi2', 'ped']) {
    const a = I.alvoDoProblema({ tipo: 'sim', unidades: { [unidade]: 1 } }, model, plan);
    if (a.exata) assert.equal(a.unidade, unidade);
  }
});

test('falta: a hora escolhida é a de um horário em que alguém marcado faltou, na hora do dia com mais faltas', () => {
  const alvo = I.alvoDoProblema(por('cartao-faltas'), model, plan);
  assert.equal(alvo.tipo, 'falta'); assert.equal(alvo.exata, true);
  const faltas = model.jobs.filter((j) => j.absent);
  assert(faltas.some((j) => j.unit === alvo.unidade && j.slot === alvo.minuto && j.type === alvo.setor), 'o minuto é o horário de uma pessoa que faltou naquela sala');
  const grupos = {};
  for (const j of faltas) { const k = j.unit + '|' + Math.floor(j.slot / 60); grupos[k] = (grupos[k] ?? 0) + 1; }
  const mais = Math.max(...Object.values(grupos));
  assert.equal(grupos[alvo.unidade + '|' + Math.floor(alvo.minuto / 60)], mais);
});

test('atraso: o minuto com mais gente que já passou do horário e ainda não chegou', () => {
  const alvo = I.alvoDoProblema({ tipo: 'etapa-hoje', unidades: null }, model, plan);
  if (!alvo.exata) { assert.match(alvo.aviso, /ninguém chegou atrasado/); return; }
  assert.equal(alvo.area, 'door'); assert.match(alvo.local, /^Entrada/);
  const m = alvo.legenda.match(/passaram (\d+) min/); const limite = Number(m[1]);
  const conta = (u, t) => model.jobs.filter((j) => j.unit === u && !j.absent && j.slot + limite <= t && t < j.arrive).length;
  const n = conta(alvo.unidade, alvo.minuto);
  for (const u of Object.keys(E.units)) for (let t = E.OPEN; t <= 1200; t++) assert(conta(u, t) <= n);
});

test('vazio: a hora em que a unidade está mais livre, com sala que existe e conta de estações livres coerente', () => {
  const alvo = I.alvoDoProblema(por('etapa-pedidos'), model, plan);
  assert.equal(alvo.tipo, 'vazio'); assert.equal(alvo.exata, true);
  assert(alvo.minuto >= 8 * 60 && alvo.minuto < 17 * 60);
  assert(plan[alvo.unidade + ':' + alvo.setor] >= 1); assert(!['reception', 'prep'].includes(alvo.setor));
  assert.match(alvo.legenda, /livres/);
});

test('sem hora: chat, resultado e cartões do chat NÃO inventam horário — vão à recepção, não mexem na hora e dizem por quê', () => {
  for (const id of ['etapa-chat', 'etapa-resultado', 'cartao-entraram', 'cartao-agendaram', 'cartao-novas']) {
    const a = I.alvoDoProblema(por(id), model, plan);
    assert.equal(a.exata, false, id); assert.equal(a.minuto, null); assert.equal(a.inicio, null);
    assert.equal(a.setor, 'reception'); assert.match(a.aviso, /não invento um horário/);
    assert(E.units[a.unidade]);
  }
});

test('dia sem problema ou sem dados: avisa em vez de inventar, e nunca quebra', () => {
  const calmo = E.simulate(E.makeRoster(dia).slice(0, 1), plan, E.seeds[0], false, 0);
  const sem = I.alvoDoProblema({ tipo: 'cartao-faltas' }, calmo, plan);
  assert.equal(sem.exata, false); assert.match(sem.aviso, /ninguém faltou/);
  for (const modelo of [undefined, { jobs: [] }]) {
    const a = I.alvoDoProblema({ tipo: 'etapa-clinica', unidades: null }, modelo, plan);
    assert.equal(a.exata, false); assert(E.units[a.unidade]);
  }
});
