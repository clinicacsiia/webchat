// Testes com dados INVENTADOS (nenhum paciente real) do leitor do #14637.
import test from "node:test";
import assert from "node:assert/strict";
import { acharColunas, faixas, lerData, mapear, dataOk } from "./mapa.ts";

const TIT = ["Data do Atendimento", "Primeira Vez", "Paciente - Nome", "Profissional", "Paciente - CPF", "Paciente - Prontuario", "Paciente - Nascimento"];
const colunas = (t: string[]) => t.map((title, i) => ({ name: `col${i}`, title }));

test("acha as colunas pelo título (qualquer ordem, sem acento ou caixa)", () => {
  const r = acharColunas(colunas(TIT));
  assert.deepEqual(r.faltando, []);
  assert.equal(r.cols.cpf, "col4"); assert.equal(r.cols.pront, "col5"); assert.equal(r.cols.nasc, "col6"); assert.equal(r.cols.prof, "col3");
  const trocada = acharColunas(colunas([...TIT].reverse().map((t) => t.toUpperCase())));
  assert.deepEqual(trocada.faltando, []);
  assert.equal(trocada.cols.data, "col6");
});
test("título obrigatório sumido para a leitura; prontuário é opcional", () => {
  assert.deepEqual(acharColunas(colunas(TIT.filter((t) => t !== "Profissional"))).faltando, ["Profissional"]);
  assert.deepEqual(acharColunas(colunas(TIT.filter((t) => t !== "Paciente - Prontuario"))).faltando, []);
  assert.equal(acharColunas([]).faltando.length, 4);
});
test("lerData aceita ISO e dd/mm/aaaa e recusa o resto", () => {
  assert.equal(lerData("2026-11-02 08:30:00"), "2026-11-02");
  assert.equal(lerData("02/11/2026"), "2026-11-02");
  assert.equal(lerData("31/02/2026"), "");
  assert.equal(lerData("lixo"), ""); assert.equal(lerData(""), "");
  assert.equal(dataOk("2026-11-02"), true); assert.equal(dataOk("02/11/2026"), false);
});
test("mapear: só CPF de 11 dígitos, nascimento, data e profissional; devolve só os campos necessários", () => {
  const { cols } = acharColunas(colunas(TIT));
  const linha = (o: Record<string, string>) => ({ col0: "2026-11-02", col1: "S", col2: "Fulana de Teste", col3: "MEDICA EXEMPLO", col4: "111.444.777-35", col5: "123", col6: "25/03/1980", ...o });
  const { itens, descartadas } = mapear([linha({}), linha({ col4: "123" }), linha({ col6: "" }), linha({ col3: "" }), linha({ col0: "x" })], cols);
  assert.equal(itens.length, 1); assert.equal(descartadas, 4);
  assert.deepEqual(itens[0], { c: "11144477735", n: "1980-03-25", p: "123", q: "MEDICA EXEMPLO", d: "2026-11-02" });
  assert.equal(JSON.stringify(itens).includes("Fulana"), false, "o nome do paciente nunca é lido");
});
test("faixas: no máximo 14 dias, sem buracos nem repetição", () => {
  const f = faixas("2026-10-01", "2026-11-15");
  assert.deepEqual(f[0], ["2026-10-01", "2026-10-14"]);
  assert.deepEqual(f.at(-1), ["2026-11-12", "2026-11-15"]);
  assert.equal(f.length, 4);
  assert.deepEqual(faixas("2026-11-15", "2026-11-15"), [["2026-11-15", "2026-11-15"]]);
});
