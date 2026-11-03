// Testes com dados INVENTADOS (nenhum paciente real).
import test from "node:test";
import assert from "node:assert/strict";
import { conferir, cpfDigitos, cpfFormatos, janela, marcacoes, nascimentoIso, prontuarioValido, resultados } from "./mapa.ts";

const A = (o: Record<string, unknown> = {}) => ({ col0: "9001", col1: "Fulana de Teste", col2: "123.456.789-09", col3: "1990-05-17", col4: "f@teste.com", col5: "71900000001", col6: "", col7: "2020-01-01", ...o });

test("CPF: só dígitos, 11 posições, os dois formatos", () => {
  assert.equal(cpfDigitos("123.456.789-09"), "12345678909");
  assert.equal(cpfDigitos("1234567890"), null);
  assert.deepEqual(cpfFormatos("12345678909"), ["12345678909", "123.456.789-09"]);
});
test("nascimento: aceita ISO, BR e com hora; recusa data impossível", () => {
  assert.equal(nascimentoIso("1990-05-17"), "1990-05-17");
  assert.equal(nascimentoIso("17/05/1990"), "1990-05-17");
  assert.equal(nascimentoIso("1990-05-17T00:00:00.000Z"), "1990-05-17");
  assert.equal(nascimentoIso("1990-02-31"), null);
  assert.equal(nascimentoIso("abc"), null);
});
test("prontuário: recusa caracteres estranhos", () => {
  assert.equal(prontuarioValido("9001"), "9001");
  assert.equal(prontuarioValido("1;drop"), null);
  assert.equal(prontuarioValido(""), null);
});
test("conferir: CPF encontrado e nascimento bate", () => {
  const v = conferir([A()], "1990-05-17", "12345678909");
  assert.deepEqual(v, { encontrado: true, ambiguo: false, confere: true, prontuario: "9001", cadastro_faltando: ["telefone"] });
});
test("conferir: nascimento errado não revela prontuário nem o que falta", () => {
  const v = conferir([A()], "1991-01-01", "12345678909");
  assert.equal(v.confere, false); assert.equal(v.prontuario, null); assert.deepEqual(v.cadastro_faltando, []);
});
test("conferir: ninguém encontrado e CPF diferente do pedido", () => {
  assert.equal(conferir([], "1990-05-17", "12345678909").encontrado, false);
  assert.equal(conferir([A()], "1990-05-17", "00000000191").encontrado, false);
});
test("conferir: dois prontuários para o mesmo CPF é ambíguo e não confere", () => {
  const v = conferir([A(), A({ col0: "9002" })], "1990-05-17", "12345678909");
  assert.equal(v.ambiguo, true); assert.equal(v.confere, false); assert.equal(v.prontuario, null);
});
test("conferir: sem CPF (por prontuário) e nascimento no formato BR", () => {
  assert.equal(conferir([A({ col3: "17/05/1990" })], "1990-05-17").confere, true);
});
test("marcações: tira dado pessoal e valor, ordena do mais novo para o mais antigo", () => {
  const b = (o: Record<string, unknown>) => ({ col0: "9001", col1: "Fulana", col2: "123", col3: "1", col4: "10", col5: "2026-09-01", col6: "2026-10-05", col7: "08:30", col8: "", col9: "RESSONANCIA", col10: "Particular", col11: "login", col12: "380", col13: "obs", col14: "Confirmado", col15: "", col16: "Agendado", col17: "N", col18: "Unidade 1", col19: "7199", col20: "", ...o });
  const out = marcacoes([b({}), b({ col6: "2026-10-20", col3: "2" })]);
  assert.equal(out[0].marcacao_id, "2");
  const chaves = Object.keys(out[0]).join(",");
  for (const proibido of ["nome", "cpf", "valor", "observacao", "celular", "telefone", "login"]) assert.ok(!chaves.includes(proibido));
  assert.equal(JSON.stringify(out).includes("Fulana"), false);
  assert.equal(JSON.stringify(out).includes("380"), false);
});
test("resultados: laudo pronto só quando há data ou id; nome do paciente não sai", () => {
  const out = resultados([
    { col0: "1", col1: "9001", col2: "Fulana", col3: "TC", col4: "2026-10-01", col5: "Atendido", col6: "", col7: "" },
    { col0: "2", col1: "9001", col2: "Fulana", col3: "RM", col4: "2026-10-02", col5: "Atendido", col6: "2026-10-04", col7: "77" },
  ]);
  assert.equal(out[0].laudo_pronto, true); assert.equal(out[1].laudo_pronto, false);
  assert.equal(JSON.stringify(out).includes("Fulana"), false);
});
test("janela: no máximo 12 meses, termina hoje", () => {
  assert.deepEqual(janela(12, "2026-11-03"), { de: "2025-11-04", ate: "2026-11-03" });
  assert.equal(janela(99, "2026-11-03").de, "2025-11-04");
  assert.equal(janela(undefined, "2026-11-03").de, "2025-11-04");
  assert.equal(janela(1, "2026-11-03").de, "2026-10-04");
});
