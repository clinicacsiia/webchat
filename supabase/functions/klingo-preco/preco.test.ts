import { test } from "node:test";
import assert from "node:assert/strict";
import { lerValor, limparIds } from "./preco.ts";

test("valor numérico positivo vira preço", () => { assert.equal(lerValor({ id_item_tabela: null, valor: 580 }), 580); assert.equal(lerValor({ valor: "69,90" }), 69.9); });
test("sem valor, zero, negativo, texto ou absurdo = sem preço", () => {
  for (const x of [null, undefined, {}, { valor: null }, { valor: 0 }, { valor: -5 }, { valor: "abc" }, { valor: 1e6 }, "x"]) assert.equal(lerValor(x), null);
});
test("ids: só inteiros positivos, sem repetir, no máximo 20", () => {
  assert.deepEqual(limparIds([630, "645", 630, -1, 0, 1.5, "x", null]), [630, 645]);
  assert.equal(limparIds(Array.from({ length: 50 }, (_, i) => i + 1)).length, 20);
  assert.deepEqual(limparIds("630"), []);
});
