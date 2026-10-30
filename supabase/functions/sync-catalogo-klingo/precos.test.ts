// Rodar: node --experimental-strip-types --test supabase/functions/sync-catalogo-klingo/precos.test.ts
// Só dados fictícios.
import test from "node:test";
import assert from "node:assert/strict";
import { agregarPrecos, valorEmReais } from "./precos.ts";

test("valorEmReais entende os formatos do Klingo", () => {
  assert.equal(valorEmReais(250), 250);
  assert.equal(valorEmReais("250"), 250);
  assert.equal(valorEmReais("250.5"), 250.5);
  assert.equal(valorEmReais("250,50"), 250.5);
  assert.equal(valorEmReais("1.250,50"), 1250.5);
  assert.equal(valorEmReais("R$ 1.250,50"), 1250.5);
  assert.equal(valorEmReais("1.250"), 1250);
});

test("valorEmReais recusa o que não é preço", () => {
  for (const v of [0, -5, "0,00", "", null, undefined, "abc", "12a", 150000, NaN, "R$"]) assert.equal(valorEmReais(v), null, String(v));
});

const l = (o: Record<string, unknown> = {}) => ({ Procedimento: "ULTRASSONOGRAFIA ABDOMEN", Operadora: "PARTICULAR", Previsto: "260,00", Quantidade: 1, ...o });

test("agrega por exame e operadora: valor mais frequente, mínimo, máximo e amostras", () => {
  const r = agregarPrecos([l(), l(), l(), l({ Previsto: "240,00" }), l({ Operadora: "UNIMED", Previsto: "180" })], "2026-10-30", "2026-12-14");
  assert.equal(r.length, 2);
  const p = r.find((x) => x.operadora === "PARTICULAR")!;
  assert.deepEqual([p.valor_tipico, p.valor_min, p.valor_max, p.amostras, p.ini, p.fim], [260, 240, 260, 4, "2026-10-30", "2026-12-14"]);
  assert.equal(r.find((x) => x.operadora === "UNIMED")!.valor_tipico, 180);
});

test("acento, caixa e pontuação não separam o mesmo exame", () => {
  const r = agregarPrecos([l({ Procedimento: "Ressonância Magnética de Joelho" }), l({ Procedimento: "RESSONANCIA MAGNETICA DE JOELHO" })], "a", "b");
  assert.equal(r.length, 1);
  assert.equal(r[0].amostras, 2);
});

test("ignora quantidade maior que 1, valor inválido e linha sem exame ou operadora", () => {
  const r = agregarPrecos([l({ Quantidade: 2 }), l({ Previsto: "" }), l({ Previsto: 0 }), l({ Procedimento: "" }), l({ Operadora: "" }), l({ Operadora: "123" })], "a", "b");
  assert.deepEqual(r, []);
});

test("empate fica com o menor valor, qualquer que seja a ordem das linhas", () => {
  const a = agregarPrecos([l({ Previsto: "300" }), l({ Previsto: "200" })], "a", "b");
  const b = agregarPrecos([l({ Previsto: "200" }), l({ Previsto: "300" })], "a", "b");
  assert.equal(a[0].valor_tipico, 200);
  assert.deepEqual(a, b);
});

test("a saída não carrega nenhum campo de paciente", () => {
  const r = agregarPrecos([l({ Paciente: "ANA MARIA SOUZA", Telefone: "71988710544", Prontuario: "123", Obs: "x" })], "a", "b");
  assert.deepEqual(Object.keys(r[0]).sort(), ["amostras", "fim", "ini", "operadora", "procedimento", "valor_max", "valor_min", "valor_tipico"]);
  assert.ok(!JSON.stringify(r).match(/ANA|71988|123/));
});
