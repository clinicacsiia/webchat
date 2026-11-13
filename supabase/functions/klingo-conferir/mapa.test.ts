// Testes com dados INVENTADOS (nenhum paciente real).
import test from "node:test";
import assert from "node:assert/strict";
import { hashCpf, hashEmail, hashFone, janelaLeitura, mapearLinha, prepararLinhas, emLotes } from "./mapa.ts";

const SAL = "segredo-de-teste";
const R = (o: Record<string, unknown> = {}) => ({
  col0: "9001", col1: "2026-11-12 10:30", col2: "2026-11-20 08:00", col3: "Whatsapp", col9: "CLÍNICA DE SAÚDE E IMAGEM - CSI", col8: "Particular", col7: "Raio X",
  col10: "Fulana de Teste", col11: "Aberta", col12: "529.982.247-25", col13: "", col14: "Fulana@Teste.com", col15: "1990-05-17", col16: "(71) 98888-7777", ...o });

test("telefone: mesma conta da Jornada (8 últimos dígitos + segredo), sem marca com menos de 8", async () => {
  assert.equal((await hashFone("71988887777", SAL)).length, 64);
  assert.equal(await hashFone("71988887777", SAL), await hashFone("(71) 98888-7777", SAL));
  assert.equal(await hashFone("88887777", SAL), await hashFone("+55 71 9 8888-7777", SAL));
  assert.equal(await hashFone("1234567", SAL), "");
});
test("CPF: só com 11 dígitos; e-mail: minúsculas e formato válido", async () => {
  assert.equal(await hashCpf("529.982.247-25", SAL), await hashCpf("52998224725", SAL));
  assert.equal(await hashCpf("1234", SAL), "");
  assert.equal(await hashEmail("Fulana@Teste.com", SAL), await hashEmail("fulana@teste.com", SAL));
  assert.equal(await hashEmail("sem-arroba", SAL), "");
});
test("linha completa: sai hash, nunca o dado em claro", async () => {
  const l = (await mapearLinha(R(), SAL))!;
  assert.equal(l.m, "9001"); assert.equal(l.em, "2026-11-12"); assert.equal(l.para, "2026-11-20"); assert.equal(l.o, "Whatsapp"); assert.equal(l.nasc, "1990-05-17");
  assert.deepEqual(l.vz, []);
  const dump = JSON.stringify(l);
  for (const segredo of ["529", "98888", "Fulana@", "fulana@", "7777"]) assert.equal(dump.includes(segredo), false, `vazou ${segredo}`);
});
test("campos vazios viram só o nome do campo; telefone fixo conta como celular", async () => {
  const l = (await mapearLinha(R({ col12: "", col14: "", col16: "", col13: "7133334444" }), SAL))!;
  assert.deepEqual(l.vz, ["cpf", "email"]);
  const m = (await mapearLinha(R({ col12: "", col14: "", col16: "", col13: "" }), SAL))!;
  assert.deepEqual(m.vz, ["cpf", "email", "celular"]);
  const c = (await mapearLinha(R({ col12: "123" }), SAL))!;
  assert.ok(c.vz.includes("cpf"), "CPF com tamanho errado conta como vazio");
});
test("origem em branco segue em branco (o banco troca por sem_origem)", async () => {
  assert.equal((await mapearLinha(R({ col3: "" }), SAL))!.o, "");
});
test("linha sem id numérico ou sem data de marcação é descartada; repetida vale a última", async () => {
  assert.equal(await mapearLinha(R({ col0: "" }), SAL), null);
  assert.equal(await mapearLinha(R({ col0: "12;drop" }), SAL), null);
  assert.equal(await mapearLinha(R({ col1: "" }), SAL), null);
  const r = await prepararLinhas([R(), R({ col11: "Cancelada" }), R({ col0: "" })], SAL);
  assert.equal(r.linhas.length, 1); assert.equal(r.descartadas, 1); assert.equal(r.linhas[0].s, "Cancelada");
});
test("janela: dias para trás contando hoje, limitada a 31; de/até só se válidos", () => {
  assert.deepEqual(janelaLeitura({ dias: 4 }, "2026-11-13"), { de: "2026-11-10", ate: "2026-11-13" });
  assert.deepEqual(janelaLeitura({ dias: 999 }, "2026-11-13"), { de: "2026-10-14", ate: "2026-11-13" });
  assert.deepEqual(janelaLeitura({}, "2026-11-13"), { de: "2026-11-10", ate: "2026-11-13" });
  assert.deepEqual(janelaLeitura({ de: "2026-11-09", ate: "2026-11-12" }, "2026-11-13"), { de: "2026-11-09", ate: "2026-11-12" });
  assert.deepEqual(janelaLeitura({ de: "2026-11-09", ate: "2027-01-01" }, "2026-11-13"), { de: "2026-11-10", ate: "2026-11-13" });
});
test("lotes", () => { assert.deepEqual(emLotes([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]); });
