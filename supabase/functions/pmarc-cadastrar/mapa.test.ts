// Testes com dados INVENTADOS (nenhum paciente real).
import test from "node:test";
import assert from "node:assert/strict";
import { chavePessoa, emLotes, hojeBrasilia, janelas, layoutPorTitulos, LAYOUT_FIXO, mapearCadastro, mapearEnriquecer, modoValido, normNome, prepararCadastro, prepararEnriquecer } from "./mapa.ts";

const SAL = "segredo-de-teste";
const R = (o: Record<string, unknown> = {}) => ({
  col0: "9001", col2: "Fulana de Teste", col4: "12345", col15: "Aberta", col16: "(71) 98888-7777", col14: "", col20: "N", ...o });

test("chave da pessoa: prontuário; sem prontuário, 'n:' + hash estável de nome e telefone (igual ao da Jornada)", async () => {
  assert.equal(await chavePessoa(R(), LAYOUT_FIXO, SAL), "12345");
  const a = await chavePessoa(R({ col4: "" }), LAYOUT_FIXO, SAL);
  assert.match(a, /^n:[0-9a-f]{24}$/);
  assert.equal(a, await chavePessoa(R({ col4: "", col2: "FULANA  DE TESTE", col16: "71 98888-7777" }), LAYOUT_FIXO, SAL));
  assert.notEqual(a, await chavePessoa(R({ col4: "", col16: "71 91111-2222" }), LAYOUT_FIXO, SAL));
  assert.equal(await chavePessoa(R({ col4: "", col2: "" }), LAYOUT_FIXO, SAL), "");
  assert.equal(normNome("José  da Conceição"), "JOSE DA CONCEICAO");
});
test("celular vazio: usa os 8 últimos dígitos do telefone, como a Jornada", async () => {
  const sem = await chavePessoa(R({ col4: "", col16: "" , col14: "7133334444" }), LAYOUT_FIXO, SAL);
  const igual = await chavePessoa(R({ col4: "", col16: "", col14: "(71) 3333-4444" }), LAYOUT_FIXO, SAL);
  assert.equal(sem, igual);
});
test("só marcação ABERTA entra; cancelada, bloqueada e sem id ficam de fora", async () => {
  assert.ok(await mapearCadastro(R(), LAYOUT_FIXO, SAL));
  assert.equal(await mapearCadastro(R({ col15: "Cancelada" }), LAYOUT_FIXO, SAL), null);
  assert.equal(await mapearCadastro(R({ col15: "Bloqueada" }), LAYOUT_FIXO, SAL), null);
  assert.equal(await mapearCadastro(R({ col0: "" }), LAYOUT_FIXO, SAL), null);
});
test("linha do cadastro: nome, celular e telefone só com dígitos; primeira vez em maiúscula", async () => {
  const l = (await mapearCadastro(R({ col20: "s", col14: "(71) 3333-4444" }), LAYOUT_FIXO, SAL))!;
  assert.deepEqual(l, { p: "12345", n: "Fulana de Teste", c: "71988887777", t: "7133334444", v: "S" });
});
test("várias marcações da mesma pessoa viram uma linha; primeira vez vale S se alguma disser S", async () => {
  const { linhas, descartadas } = await prepararCadastro([R({ col0: "1", col16: "" }), R({ col0: "2", col20: "S" }), R({ col0: "3", col15: "Cancelada" }), R({ col0: "4", col4: "999", col2: "Outro" })], LAYOUT_FIXO, SAL);
  assert.equal(linhas.length, 2); assert.equal(descartadas, 1);
  const f = linhas.find((x) => x.p === "12345")!;
  assert.equal(f.c, "71988887777"); assert.equal(f.v, "S");
});
test("colunas pelo título: reordenar não quebra; título obrigatório sumido é apontado; opcionais não bloqueiam", () => {
  const cols = [["col0", "Id da Marcação"], ["col7", "Paciente - Nome"], ["col3", "Prontuário"], ["col9", "Status"], ["col5", "Paciente - Celular"], ["col6", "Primeira Vez"]].map(([name, title]) => ({ name, title }));
  const { layout, faltando, por } = layoutPorTitulos(cols);
  assert.equal(por, "título"); assert.deepEqual(faltando, []);
  assert.equal(layout.nome, "col7"); assert.equal(layout.cel, "col5"); assert.equal(layout.tel, undefined); assert.equal(layout.primeira, "col6");
  const semStatus = layoutPorTitulos(cols.filter((c) => c.title !== "Status"));
  assert.deepEqual(semStatus.faltando, ["Status"]);
  assert.equal(layoutPorTitulos(undefined).por, "ordem fixa");
});
test("#14554: nascimento e e-mail seguem; CPF vira só 'tem CPF'; id inválido é descartado", () => {
  const l = mapearEnriquecer({ col0: "55", col12: "529.982.247-25", col13: "", col14: "Fulana@Teste.com", col15: "1990-05-17 00:00:00", col16: "(71) 98888-7777" })!;
  assert.deepEqual(l, { m: "55", c: "71988887777", t: "", e: "fulana@teste.com", d: "1990-05-17", k: true });
  assert.equal(JSON.stringify(l).includes("529"), false);
  assert.equal(mapearEnriquecer({ col0: "abc" }), null);
  assert.equal(mapearEnriquecer({ col0: "1", col12: "123" })!.k, false);
  const { linhas, descartadas } = prepararEnriquecer([{ col0: "1" }, { col0: "1", col14: "a@b.co" }, { col0: "x" }]);
  assert.equal(linhas.length, 1); assert.equal(descartadas, 1); assert.equal(linhas[0].e, "a@b.co");
});
test("janelas: rápido = 7 dias à frente + 3 dias de marcações; completo = 1 ano; enriquecer aceita no máximo 31 dias", () => {
  const h = "2026-11-17";
  assert.deepEqual(janelas("rapido", h), { exame: { de: h, ate: "2026-11-24" }, feitas: { de: "2026-11-15", ate: h } });
  assert.deepEqual(janelas("completo", h), { exame: { de: h, ate: "2027-11-17" }, feitas: null });
  assert.deepEqual(janelas("enriquecer", h, { de: "2026-10-01", ate: "2026-10-31" }), { exame: null, feitas: { de: "2026-10-01", ate: "2026-10-31" } });
  assert.deepEqual(janelas("enriquecer", h, { de: "2026-01-01", ate: "2026-10-31" }).feitas, { de: "2026-10-18", ate: h });
  assert.deepEqual(janelas("enriquecer", h, { de: "lixo", ate: "x" }).feitas, { de: "2026-10-18", ate: h });
  assert.equal(modoValido("completo"), "completo"); assert.equal(modoValido("x"), "rapido"); assert.equal(modoValido("enriquecer"), "enriquecer");
  assert.match(hojeBrasilia(), /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(emLotes([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
