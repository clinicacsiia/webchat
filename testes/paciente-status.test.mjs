// FLUXOGRAMA: entrada (status do chat e do Klingo) -> validação (módulo paciente-status.js carregado no Node) -> lógica (cada status vira o passo certo, desvios pedem ação, desconhecido não quebra) -> saída (PASS/FAIL por caso)
// Versão 1.0 — 02/11/2026 / Mudança: Implementação inicial
import { createRequire } from 'node:module';
import { REPO } from './stubs-supabase.mjs';

const P = createRequire(import.meta.url)(`${REPO}/paciente-status.js`);
const resultados = [];
const caso = (nome, ok, detalhe = '') => { resultados.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${nome}${detalhe ? '  -- ' + detalhe : ''}`); };

const esperado = [
  ['chat', 'rascunho', 'rascunho', true], ['chat', 'pronto', 'pronto', true], ['chat', 'marcado', 'marcado', false], ['chat', 'compareceu', 'atendido', true],
  ['chat', 'faltou', 'faltou', true], ['chat', 'cancelou', 'cancelou', true], ['chat', 'remarcou', 'remarcou', true],
  ['klingo', 'agendado', 'marcado', false], ['klingo', 'confirmado', 'confirmado', false], ['klingo', 'atendido', 'atendido', true],
  ['klingo', 'cancelado', 'cancelou', true], ['klingo', 'remarcado', 'remarcou', true], ['klingo', 'faltou', 'faltou', true], ['klingo', 'pedido', 'pedido', false],
];
for (const [origem, status, id, acao] of esperado) {
  const p = P.passo(status, origem);
  caso(`${origem}:${status} -> ${id} (${acao ? 'pede ação' : 'segue'})`, p.id === id && p.precisaAcao === acao && p.rotulo.length > 0 && (p.desvio || p.ordem > 0), JSON.stringify(p));
}
const d = P.passo('qualquer coisa', 'klingo');
caso('status desconhecido não quebra e mostra o texto original', d.id === null && d.rotulo === 'qualquer coisa' && !d.precisaAcao);
caso('sem status e sem origem não quebra', P.passo(undefined).id === null && P.passo(null, 'klingo').rotulo === 'Sem status');
caso('maiúsculas e espaços não atrapalham', P.passo('  AGENDADO ', 'klingo').id === 'marcado');
caso('o caminho tem 7 passos em ordem, do pedido ao resultado', P.CAMINHO.map((x) => x.id).join('>') === 'pedido>pronto>marcado>confirmado>chegou>atendido>laudo');
const r = P.resumo([{ status: 'faltou', origem: 'chat' }, { status: 'agendado', origem: 'klingo' }, { status: 'atendido', origem: 'klingo' }, { status: 'xx', origem: 'klingo' }]);
caso('resumo: 4 exames, 2 pedindo ação (falta e exame feito), o mais avançado é "atendido"', r.total === 4 && r.pedindoAcao === 2 && r.maisAvancado === 'atendido' && r.porPasso.desconhecido === 1, JSON.stringify(r));
caso('resumo de lista vazia ou inválida não quebra', P.resumo([]).total === 0 && P.resumo(null).total === 0 && P.resumo([null]).total === 1);

const ok = resultados.filter(Boolean).length;
console.log(`\n${ok}/${resultados.length} verificações passaram`);
process.exit(ok === resultados.length ? 0 : 1);
