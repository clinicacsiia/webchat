// Testes com dados inventados (nenhuma chamada de rede). Versão 1.0 — 14/11/2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import { janelasDoPeriodo } from "./vigia.ts";

test("período curto vira uma janela só; o início nunca é no passado", () => {
  assert.deepEqual(janelasDoPeriodo("2026-11-14", "2026-11-10", "2026-11-20"), [{ inicio: "2026-11-14", fim: "2026-11-20" }]);
});
test("período longo é cortado em janelas de 15 dias seguidas, no máximo 3 por rodada (cota)", () => {
  const j = janelasDoPeriodo("2026-11-14", "2026-11-14", "2027-03-01");
  assert.equal(j.length, 3); assert.deepEqual(j[0], { inicio: "2026-11-14", fim: "2026-11-28" }); assert.deepEqual(j[1], { inicio: "2026-11-29", fim: "2026-12-13" }); assert.deepEqual(j[2], { inicio: "2026-12-14", fim: "2026-12-28" });
});
test("período que já terminou ou datas inválidas: nenhuma janela (a solicitação expira, não consulta a API)", () => {
  assert.deepEqual(janelasDoPeriodo("2026-11-14", "2026-10-01", "2026-11-13"), []);
  assert.deepEqual(janelasDoPeriodo("2026-11-14", "x", "2026-12-01"), []);
});
test("começa no futuro: a primeira janela começa na data inicial pedida", () => {
  assert.deepEqual(janelasDoPeriodo("2026-11-14", "2026-12-01", "2026-12-05"), [{ inicio: "2026-12-01", fim: "2026-12-05" }]);
});
