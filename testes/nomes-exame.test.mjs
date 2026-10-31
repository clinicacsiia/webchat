// FLUXOGRAMA: entrada (nomes REAIS de exame lidos do catálogo de produção em 31/10/2026 e nomes-exame.js carregado no Node) -> validação (cada nome vira título e detalhe legíveis) -> lógica (tira prefixo e "(UNILATERAL)", separa parênteses, detecta nome cortado, ordena comuns primeiro, junta o que fica igual na tela) -> saída (PASS/FAIL por caso e código de saída)
// Versão 1.0 — 31/10/2026 / Mudança: Implementação inicial
import { createRequire } from 'node:module';
import { REPO } from './stubs-supabase.mjs';

const N = createRequire(import.meta.url)(`${REPO}/nomes-exame.js`);
const resultados = [];
const registrar = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };
const mostra = (a) => `${a.titulo}${a.detalhe ? ' | ' + a.detalhe : ''}`;
const sem = { semPrefixo: true };

// Os casos da captura da paciente (Punho/mão e Perna, lado esquerdo).
const esperado = [
  ['RM ARTICULAR (POR ARTICULAÇÃO)', 'Articular | Por articulação'],
  ['RM MÃO (NÃO INCLUI PUNHO)', 'Mão | Não inclui punho'],
  ['RM DE MÃO E PUNHO - INCLUI ARTRO-RESSONÂNCIA (UNILATERAL)', 'Mão e punho | Inclui artro-ressonância'],
  ['RM PUNHO (INCLUI ARTRO-RESSONÂNCIA) UNILATERAL', 'Punho | Inclui artro-ressonância'],
  ['RM DE MEMBRO INFERIOR UNILATERAL (NÃO INCLUI ARTICULAÇÕES)', 'Membro inferior | Não inclui articulações'],
  ['RM PERNA (UNILATERAL)', 'Perna'],
  ['ANGIO-RM ARTERIAL DE MEMBRO INFERIOR (UNILATERAL)', 'Angio-RM arterial de membro inferior'],
  ['ANGIO-RM VENOSA DE MEMBRO INFERIOR (UNILATERAL)', 'Angio-RM venosa de membro inferior'],
  ['RM DE JOELHO ( UNILATERAL )', 'Joelho'],
  ['US ABDOME SUPERIOR (FÍGADO, VIAS BILIARES, VESÍCULA, PÂNCREAS, BAÇO)', 'Abdome superior | Fígado, vias biliares, vesícula, pâncreas, baço'],
  ['TC TÓRAX', 'Tórax'],
  ['ULTRA-SONOGRAFIA DE ARTICULACAO', 'Articulacao'],
  ['USG ABDÔMEN SUPERIOR', 'Abdômen superior'],
  ['RM CRÂNIO (ENCÉFALO)', 'Crânio | Encéfalo'],
  ['RM DE FACE / ATM / SELA TÚRCICA', 'Face / ATM / sela túrcica'],
];
for (const [bruto, certo] of esperado) {
  const r = mostra(N.apresentar(bruto, sem));
  registrar(`"${bruto.slice(0, 58)}"`, r === certo, r === certo ? r : `saiu "${r}", esperado "${certo}"`);
}

const cortado = N.apresentar('RM ABDOME SUPERIOR (FÍGADO, PÂNCREAS, BAÇO, RINS, SUPRA-RENAIS, RETRO', sem);
registrar('nome cortado pelo banco (parêntese aberto) termina com reticências e não fica com "(" solto', /…$/.test(cortado.detalhe) && !/[()]/.test(mostra(cortado)), mostra(cortado));
registrar('sem tirar o prefixo (busca por nome) a sigla fica: "RM de joelho"', N.apresentar('RM DE JOELHO ( UNILATERAL )').titulo === 'RM de joelho');
registrar('nenhum nome apresentado fica em CAIXA ALTA', esperado.every(([b]) => { const a = N.apresentar(b, sem); return a.titulo !== a.titulo.toUpperCase() || a.titulo.length < 4; }));

// Organização: comuns primeiro, repetidos juntados, o resto atrás de "ver mais".
const punho = ['RM ARTICULAR (POR ARTICULAÇÃO)', 'RM DE MÃO E PUNHO - INCLUI ARTRO-RESSONÂNCIA (UNILATERAL)', 'RM MÃO (NÃO INCLUI PUNHO)', 'RM PUNHO (INCLUI ARTRO-RESSONÂNCIA) UNILATERAL'].map((nome, id) => ({ id, nome }));
const op = N.organizar(punho, sem);
registrar('punho/mão: 4 exames cabem na tela sem "ver mais", e os mais simples vêm primeiro', op.outros.length === 0 && op.principais.length === 4 && op.principais[0].titulo === 'Mão', op.principais.map((e) => e.titulo).join(' / '));

const cranio = ['ANGIO RM ARTERIAL CRANIO', 'ANGIO-RM ARTERIAL DE CRÂNIO', 'ANGIO-RM VENOSA DE CRÂNIO', 'PCT ANGIO-RM CRÂNIO', 'PERFUSÃO CEREBRAL POR RM', 'RM BASE DO CRÂNIO', 'RM CRÂNIO (ENCÉFALO)',
  'RM DE CRÂNIO', 'RM DE FACE / ATM / SELA TÚRCICA', 'RM DO CRANIO', 'RM NEURONAVEGADOR', 'RM OSSOS TEMPORAIS BILATERAL', 'RM SELA TÚRCICA (HIPÓFISE)', 'RM TRACTOGRAFIA'].map((nome, id) => ({ id, nome }));
const oc = N.organizar(cranio, sem);
const todos = [...oc.principais, ...oc.outros];
const chaves = todos.map((e) => `${e.titulo}|${e.detalhe}`);
registrar('crânio: "RM DE CRÂNIO" e "RM DO CRANIO" (iguais na tela) viram um só', new Set(chaves).size === chaves.length && todos.length === cranio.length - 1, `${cranio.length} -> ${todos.length}`);
registrar('crânio: os comuns aparecem antes e os especiais (angio, PCT, neuronavegador, tractografia) vão para "ver mais"', oc.principais.every((e) => !/angio|pct|neuro|tractografia/i.test(e.titulo)) && oc.outros.length > 0, `principais: ${oc.principais.map((e) => e.titulo).join(' / ')}`);
registrar('o id do exame nunca é perdido ou trocado', todos.every((e) => Number.isInteger(e.id)) && new Set(todos.map((e) => e.id)).size === todos.length);
registrar('lista vazia ou sem nome não quebra', N.organizar([], sem).principais.length === 0 && N.apresentar('', sem).titulo === '' && N.apresentar(null).titulo === '');

const falhas = resultados.filter((r) => !r).length;
console.log(`\n${resultados.length - falhas}/${resultados.length} verificações passaram`);
process.exit(falhas ? 1 : 0);
