// Rodar: node --experimental-strip-types --test supabase/functions/ler-pedido/leitura.test.ts
// Só dados fictícios.
import test from "node:test";
import assert from "node:assert/strict";
import { ESQUEMA, limparLeitura, montarPedido, montarSistema, type ItemCatalogo } from "./leitura.ts";

const CAT: ItemCatalogo[] = [[30, "RM DE JOELHO ( UNILATERAL )", "RM"], [10, "ECOCARDIOGRAMA BIDIMENSIONAL", "US"], [20, "ECOCARDIOGRAMA PEDIÁTRICO", "US"]];

test("o sistema traz o catálogo em ordem de id (texto estável para o cache)", () => {
  const s = montarSistema(CAT);
  assert.ok(s.indexOf("10 | ECOCARDIOGRAMA BIDIMENSIONAL | US") < s.indexOf("30 | RM DE JOELHO"));
  assert.equal(s, montarSistema([...CAT].reverse()));
});

test("o pedido leva o tipo de paciente e o que a equipe já ensinou", () => {
  assert.match(montarPedido("adulto", []), /O paciente é adulto/);
  assert.doesNotMatch(montarPedido("adulto", []), /já confirmou/);
  assert.match(montarPedido("criança ou adolescente", [["RNM J E", 30]]), /RNM J E → 30/);
});

test("limparLeitura descarta ids fora do catálogo, opção vazia e campos inválidos", () => {
  const r = limparLeitura({
    e_pedido_medico: true, legibilidade: "parcial", total_exames: 1, observacoes: "  com contraste  ",
    exames: [
      { escrito: "Eco", entendido: "Ecocardiograma", lado: "X", certeza: "talvez",
        opcoes: [{ rotulo: "De adulto", ids: [10, 10, 999] }, { rotulo: "Inventado", ids: [999] }, { rotulo: "De criança", ids: [20, 1.5, "30"] }] },
      { escrito: "???", entendido: "", lado: "N", certeza: "baixa", opcoes: [] },
    ],
  }, CAT);
  assert.equal(r.total_exames, 2, "total nunca menor que os exames listados");
  assert.equal(r.observacoes, "com contraste");
  assert.deepEqual(r.exames[0].opcoes, [{ rotulo: "De adulto", ids: [10] }, { rotulo: "De criança", ids: [20] }]);
  assert.equal(r.exames[0].lado, "N");
  assert.equal(r.exames[0].certeza, "baixa");
  assert.deepEqual(r.exames[1].opcoes, []);
});

test("limparLeitura aguenta resposta vazia ou estranha", () => {
  for (const v of [null, undefined, "texto", 42, [], { exames: "x" }]) {
    const r = limparLeitura(v, CAT);
    assert.deepEqual([r.exames.length, r.total_exames, r.e_pedido_medico, r.legibilidade], [0, 0, true, "ruim"], String(v));
  }
  assert.equal(limparLeitura({ e_pedido_medico: false }, CAT).e_pedido_medico, false);
  assert.equal(limparLeitura({ total_exames: 500 }, CAT).total_exames, 30);
  assert.equal(limparLeitura({ exames: Array(20).fill({ escrito: "x" }) }, CAT).exames.length, 12);
});

test("o esquema exige todos os campos e não aceita campo a mais (structured outputs)", () => {
  assert.equal(ESQUEMA.additionalProperties, false);
  assert.deepEqual([...ESQUEMA.required].sort(), Object.keys(ESQUEMA.properties).sort());
  const ex = ESQUEMA.properties.exames.items;
  assert.deepEqual([...ex.required].sort(), Object.keys(ex.properties).sort());
  const op = ex.properties.opcoes.items;
  assert.deepEqual([...op.required].sort(), Object.keys(op.properties).sort());
});
