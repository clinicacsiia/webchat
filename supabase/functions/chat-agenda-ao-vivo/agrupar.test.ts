// FLUXOGRAMA: entrada (linhas e períodos de teste, inventados) -> validação (datas ruins, períodos grandes, linhas sem horário) -> lógica (agrupamento, blocos seguidos, instante mais antigo) -> saída (PASS/FAIL do node --test)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (agenda ao vivo no chat)
import test from "node:test";
import assert from "node:assert/strict";
import { agruparMarcacoes, blocosConsecutivos, diasEntre, maisAntigo } from "./agrupar.ts";

test("agruparMarcacoes junta o mesmo horário/profissional/unidade e conta; não carrega dado de paciente", () => {
  const r = agruparMarcacoes([
    { Data_Atendimento: "2026-11-12T08:00:00", Medico: " DRA ANA ", Unidade: "CSI", Procedimento: "CONSULTA", Paciente: "FULANO", Telefone: "7199", Prontuario: "9", Obs: "x" },
    { Data_Atendimento: "2026-11-12T08:00:00", Medico: "DRA ANA", Unidade: "CSI", Procedimento: "CONSULTA", Paciente: "CICRANO" },
    { Data_Atendimento: "2026-11-12 09:00", Medico: "DRA ANA", Unidade: "CSI", Procedimento: "RETORNO" },
  ]);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { inicio: "2026-11-12 08:00:00", profissional: "DRA ANA", unidade: "CSI", procedimento: "CONSULTA", qtd: 2 });
  assert.deepEqual(Object.keys(r[0]).sort(), ["inicio", "procedimento", "profissional", "qtd", "unidade"]);
  assert.ok(!JSON.stringify(r).match(/FULANO|CICRANO|7199/));
});

test("agruparMarcacoes ignora linhas sem horário, sem profissional ou sem unidade", () => {
  const r = agruparMarcacoes([
    { Data_Atendimento: "", Medico: "A", Unidade: "U" }, { Data_Atendimento: "2026-11-12T08:00", Medico: "", Unidade: "U" },
    { Data_Atendimento: "2026-11-12T08:00", Medico: "A", Unidade: "" }, { Data_Atendimento: "lixo", Medico: "A", Unidade: "U" }, {},
  ]);
  assert.deepEqual(r, []);
});

test("diasEntre lista os dias, inclusive as pontas, também na virada de mês e de ano", () => {
  assert.deepEqual(diasEntre("2026-11-29", "2026-12-02"), ["2026-11-29", "2026-11-30", "2026-12-01", "2026-12-02"]);
  assert.deepEqual(diasEntre("2026-12-31", "2027-01-01"), ["2026-12-31", "2027-01-01"]);
  assert.deepEqual(diasEntre("2026-11-12", "2026-11-12"), ["2026-11-12"]);
});

test("diasEntre recusa datas inválidas, intervalo invertido e mais de 15 dias", () => {
  assert.throws(() => diasEntre("2026-11-12", "2026-11-11"));
  assert.throws(() => diasEntre("12/11/2026", "2026-11-13"));
  assert.throws(() => diasEntre("2026-13-40", "2026-13-41"));
  assert.throws(() => diasEntre("2026-11-01", "2026-11-16"));
  assert.equal(diasEntre("2026-11-01", "2026-11-15").length, 15);
});

test("blocosConsecutivos divide em blocos de até 4 dias seguidos e não junta dias separados", () => {
  const b = blocosConsecutivos(diasEntre("2026-11-10", "2026-11-23"));
  assert.deepEqual(b.map((x) => [x.de, x.ate, x.dias.length]), [["2026-11-10", "2026-11-13", 4], ["2026-11-14", "2026-11-17", 4], ["2026-11-18", "2026-11-21", 4], ["2026-11-22", "2026-11-23", 2]]);
  const c = blocosConsecutivos(["2026-11-10", "2026-11-12", "2026-11-13", "2026-11-10"]);
  assert.deepEqual(c.map((x) => x.dias), [["2026-11-10"], ["2026-11-12", "2026-11-13"]]);
  assert.deepEqual(blocosConsecutivos([]), []);
});

test("maisAntigo devolve o instante mais antigo e ignora vazios e inválidos", () => {
  assert.equal(maisAntigo(["2026-11-10T12:00:10Z", null, "2026-11-10T12:00:02Z", "lixo", undefined]), "2026-11-10T12:00:02Z");
  assert.equal(maisAntigo([]), null);
  assert.equal(maisAntigo([null, "x"]), null);
});
