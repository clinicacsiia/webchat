// FLUXOGRAMA: entrada (linhas inventadas do Klingo e pedidos inventados do chat) -> validação (nome completo; marcação aberta e feita depois da conversa) -> lógica (o exame bate? ambíguo?) -> saída (asserts).
// Rodar: node --experimental-strip-types --test supabase/functions/klingo-reconhecer/casar.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { casar, compat, familia, fonesDaLinha, normNome, type Alvo } from "./casar.ts";

const alvo = (o: Partial<Alvo> = {}): Alvo => ({ id: "p1", conv_criada: "2026-11-09T12:50:00Z", nome: "Maria Exemplo da Silva Santos", fones: ["00001234"], itens: ["CONSULTA"], ...o });
const linha = (o: Record<string, unknown> = {}) => ({ col0: "100", col2: "129808", col3: "2026-11-09 09:57:00", col4: "2026-12-02 08:00:00", col5: "CONSULTA", col12: "Aberta", col14: "CSI Pediatria",
  col15: "MARIA EXEMPLO DA SILVA SANTOS", col16: "(71) 90000-1234", col17: "", ...o });

test("normaliza nome e telefone", () => {
  assert.equal(normNome("João Kauã  Exemplo-Souza"), "JOAO KAUA EXEMPLO SOUZA");
  assert.deepEqual(fonesDaLinha("(71) 90000-1234 / 7133334444"), ["00001234", "33334444"]);
});
test("famílias de exame", () => {
  assert.equal(familia("CONSULTA ORTOPEDIATRA"), "CONSULTA"); assert.equal(familia("USG TRANSVAGINAL"), "US"); assert.equal(familia("MAMOGRAFIA BILATERAL"), "MAMO"); assert.equal(familia("RM DE CRÂNIO"), "RM");
});
test("exame bate: igual, contido nos dois sentidos, ou só a família", () => {
  assert.equal(compat("CONSULTA", ["CONSULTA ORTOPEDIATRA"]), "exato");
  assert.equal(compat("CONSULTA ORTOPEDIATRA", ["CONSULTA"]), "exato");
  assert.equal(compat("RM DE CRÂNIO", ["RM DE CRÂNIO"]), "exato");
  assert.equal(compat("CONSULTA NEUROPEDIATRIA", ["CONSULTA ORTOPEDIATRA"]), "familia");
  assert.equal(compat("RM DE JOELHO", ["US ABDOME"]), null);
  assert.equal(compat("CONSULTA", []), null);
});
test("nome completo + telefone = forte; só o nome completo = médio; telefone sem nome completo não conta", () => {
  assert.equal(casar(alvo(), [linha()]).identidade, "forte");
  assert.equal(casar(alvo(), [linha({ col16: "(71) 90000-0000" })]).identidade, "medio");
  const fraco = casar(alvo(), [linha({ col15: "MARIA SANTOS" })]);
  assert.equal(fraco.identidade, null); assert.equal(fraco.marcacoes.length, 0);
});
test("traz a data, a hora e a unidade reais do Klingo", () => {
  const r = casar(alvo(), [linha({ col4: "2026-12-09 09:20:00" })]);
  assert.equal(r.marcacoes.length, 1); assert.equal(r.marcacoes[0].para, "2026-12-09 09:20:00"); assert.equal(r.marcacoes[0].unidade, "CSI Pediatria"); assert.equal(r.marcacoes[0].compat, "exato");
});
test("marcação feita ANTES da conversa não é agendamento do pedido; cancelada também não", () => {
  assert.equal(casar(alvo(), [linha({ col3: "2026-10-01 10:00:00" })]).marcacoes.length, 0);
  assert.equal(casar(alvo(), [linha({ col12: "Cancelada" })]).marcacoes.length, 0);
  assert.equal(casar(alvo(), [linha({ col3: "2026-11-09 09:55:00" })]).marcacoes.length, 1, "9:55 (12:55Z) é depois de 12:50Z - 1h");
});
test("exame diferente do pedido não recebe a data; fica só contado", () => {
  const r = casar(alvo({ itens: ["RM DE CRÂNIO"] }), [linha()]);
  assert.equal(r.marcacoes.length, 0); assert.equal(r.outros_exames, 1);
});
test("vários exames: escolhe os que batem; mesma família com nome diferente só vale se for a única", () => {
  const ort = alvo({ itens: ["CONSULTA ORTOPEDIATRA"] });
  const exato = casar(ort, [linha({ col0: "1", col5: "CONSULTA ORTOPEDIATRA" }), linha({ col0: "2", col5: "CONSULTA NEUROPEDIATRIA", col4: "2026-11-24 09:20:00" })]);
  assert.deepEqual(exato.marcacoes.map((m) => m.id), ["1"]);
  const unica = casar(ort, [linha({ col0: "2", col5: "CONSULTA NEUROPEDIATRIA" })]);
  assert.equal(unica.marcacoes.length, 1); assert.equal(unica.marcacoes[0].compat, "familia");
  const duas = casar(ort, [linha({ col0: "2", col5: "CONSULTA NEUROPEDIATRIA" }), linha({ col0: "3", col5: "CONSULTA GASTROPEDIATRIA" })]);
  assert.equal(duas.ambiguo, true); assert.equal(duas.marcacoes.length, 0);
});
test("dois cadastros com o mesmo nome completo: ambíguo, nada é escolhido", () => {
  const r = casar(alvo(), [linha({ col2: "111" }), linha({ col0: "101", col2: "222" })]);
  assert.equal(r.ambiguo, true); assert.equal(r.identidade, null); assert.equal(r.marcacoes.length, 0);
});
test("nome de uma palavra só nunca casa", () => {
  assert.equal(casar(alvo({ nome: "Maria" }), [linha({ col15: "MARIA" })]).marcacoes.length, 0);
});
