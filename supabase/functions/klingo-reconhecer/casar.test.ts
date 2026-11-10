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

// ---- Prontuário conferido (AGE-01, 10/11/2026) ----
test("prontuário conferido: o nome digitado errado no chat não impede (corrigido só no Klingo), sem telefone igual", () => {
  const a = alvo({ nome: "Maria Exmplo", fones: ["99999999"], prontuarios: ["129808"] });
  const sem = casar({ ...a, prontuarios: [] }, [linha()]);
  assert.equal(sem.marcacoes.length, 0, "sem prontuário conferido, nome errado e telefone diferente não casam (regra de sempre)");
  const r = casar(a, [linha()]);
  assert.equal(r.marcacoes.length, 1); assert.equal(r.identidade, "forte"); assert.equal(r.por_prontuario, true); assert.equal(r.ambiguo, false);
});
test("prontuário conferido: homônimo com outro prontuário é ignorado, e não vira ambíguo", () => {
  const a = alvo({ prontuarios: ["129808"] });
  const r = casar(a, [linha({ col0: "100", col2: "129808" }), linha({ col0: "200", col2: "555555", col3: "2026-11-09 10:30:00" })]);
  assert.equal(r.ambiguo, false); assert.equal(r.marcacoes.length, 1); assert.equal(r.marcacoes[0].id, "100"); assert.equal(r.cadastros, 1);
  const semConferido = casar(alvo(), [linha({ col0: "100", col2: "129808" }), linha({ col0: "200", col2: "555555" })]);
  assert.equal(semConferido.ambiguo, true, "sem prontuário conferido, dois cadastros com o mesmo nome continuam ambíguos");
});
test("prontuário conferido: marcação de OUTRO prontuário com o mesmo nome e telefone não casa quando o conferido tem marcação", () => {
  const r = casar(alvo({ prontuarios: ["129808"] }), [linha({ col0: "300", col2: "777777" }), linha({ col0: "100", col2: "129808" })]);
  assert.deepEqual(r.marcacoes.map((m) => m.id), ["100"]);
});
test("prontuário conferido: sem marcação desse prontuário, volta à regra de nome e telefone", () => {
  const r = casar(alvo({ prontuarios: ["000001"] }), [linha()]);
  assert.equal(r.marcacoes.length, 1); assert.equal(r.por_prontuario, false); assert.equal(r.identidade, "forte");
});
test("prontuário conferido: marcação anterior à conversa, cancelada ou de outro exame continua não valendo", () => {
  const a = alvo({ nome: "Fulano", prontuarios: ["129808"] });
  assert.equal(casar(a, [linha({ col3: "2026-10-01 10:00:00" })]).marcacoes.length, 0);
  assert.equal(casar(a, [linha({ col12: "Cancelada" })]).marcacoes.length, 0);
  const o = casar(alvo({ itens: ["RM DE JOELHO"], prontuarios: ["129808"] }), [linha()]);
  assert.equal(o.marcacoes.length, 0); assert.equal(o.outros_exames, 1);
});
test("prontuário conferido: dois prontuários conferidos com marcação na mesma pessoa viram ambíguo (mãe e filho, por exemplo)", () => {
  const r = casar(alvo({ prontuarios: ["129808", "129809"] }), [linha({ col0: "1", col2: "129808" }), linha({ col0: "2", col2: "129809" })]);
  assert.equal(r.ambiguo, true); assert.equal(r.marcacoes.length, 0);
});
test("prontuário conferido sem marcação útil (só uma antiga): cai na regra de sempre; dois cadastros de mesmo nome completo continuam ambíguos (a atendente decide)", () => {
  const velha = linha({ col0: "10", col2: "129808", col3: "2026-10-01 10:00:00" });
  const nova = linha({ col0: "20", col2: "888888" });   // cadastro duplicado no Klingo, nome e telefone iguais, feita depois da conversa
  const r = casar(alvo({ prontuarios: ["129808"] }), [velha, nova]);
  assert.equal(r.ambiguo, true); assert.equal(r.marcacoes.length, 0); assert.equal(r.por_prontuario, false);
  const soNova = casar(alvo({ prontuarios: ["129808"] }), [nova]);
  assert.deepEqual(soNova.marcacoes.map((m) => m.id), ["20"], "sem a marcação antiga do outro cadastro, a regra de sempre reconhece");
});
