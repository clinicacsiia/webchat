// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial. Dados inventados.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agrupar, janela, laudosProntos, nascimentoConfere, nascimentoIso } from "./mapa.ts";

test("nascimento: aceita os dois formatos do Klingo e recusa data impossível", () => {
  assert.equal(nascimentoIso("12/04/1988"), "1988-04-12");
  assert.equal(nascimentoIso("1988-04-12 00:00:00"), "1988-04-12");
  assert.equal(nascimentoIso("31/02/1988"), null);
  assert.equal(nascimentoIso(""), null);
});
test("nascimento só confere com UM cadastro daquele prontuário e a data igual", () => {
  const linhas = [{ col0: "10", col3: "12/04/1988" }];
  assert.equal(nascimentoConfere(linhas, "10", "1988-04-12"), true);
  assert.equal(nascimentoConfere(linhas, "10", "1988-04-13"), false);
  assert.equal(nascimentoConfere(linhas, "11", "1988-04-12"), false);
  assert.equal(nascimentoConfere([...linhas, { col0: "10", col3: "12/04/1988" }], "10", "1988-04-12"), false);
  assert.equal(nascimentoConfere([], "10", "1988-04-12"), false);
});
test("laudo pronto = data do laudo OU Id do laudo, casado pelo Id do atendimento", () => {
  const s = laudosProntos([
    { col0: "100", col6: "10/11/2026", col7: "" }, { col0: "101", col6: "", col7: "L55" }, { col0: "102", col6: "", col7: "" }, { col0: "", col6: "10/11/2026" },
  ]);
  assert.deepEqual([...s].sort(), ["100", "101"]);
});
test("agrupar junta por prontuário + nascimento e descarta linha inválida", () => {
  const m = agrupar([
    { id: "a", atendimento: "1", prontuario: "10", nascimento: "1988-04-12" }, { id: "b", atendimento: "2", prontuario: "10", nascimento: "12/04/1988" },
    { id: "c", atendimento: "3", prontuario: "10", nascimento: "2019-08-30" }, { id: "d", atendimento: "", prontuario: "10", nascimento: "1988-04-12" }, { id: "e", atendimento: "4", prontuario: "x y", nascimento: "1988-04-12" },
  ]);
  assert.equal(m.size, 2);
  assert.equal(m.get("10|1988-04-12")!.length, 2);
});
test("janela de 3 meses termina hoje e começa 3 meses antes", () => {
  assert.deepEqual(janela(3, "2026-11-15"), { de: "2026-08-16", ate: "2026-11-15" });
});
