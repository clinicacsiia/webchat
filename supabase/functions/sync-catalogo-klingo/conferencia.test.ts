// Rodar: node --experimental-strip-types --test supabase/functions/sync-catalogo-klingo/conferencia.test.ts
// Só dados fictícios.
import test from "node:test";
import assert from "node:assert/strict";
import { avaliar, escolherAlvos, fonesDaLinha, linhaDe, nomeConfere, normNome, type Alvo } from "./conferencia.ts";

const alvo = (extra: Partial<Alvo> = {}): Alvo => ({
  id: "pre-1", status: "pronto", conf: null, fones: ["88710544"], nomes: ["ANA MARIA SOUZA"], procs: ["RESSONANCIA MAGNETICA DE JOELHO DIREITO"],
  slots: [{ idx: 0, data: "2026-11-06", hora: "10:00", prof: "DR JOAO LIMA", unidade: "CLINICA DE SAUDE E IMAGEM UNIDADE A", chegada: false, min: 30 }],
  ...extra,
});
const linha = (o: Record<string, unknown> = {}) => linhaDe({
  Data_Atendimento: "2026-11-06T10:00:00", Medico: "Dr Joao Lima", Unidade: "CLÍNICA DE SAÚDE E IMAGEM - UNIDADE A",
  Procedimento: "RESSONÂNCIA MAGNÉTICA DE JOELHO DIREITO", Paciente: "Ana Maria Souza", Telefone: "(71) 98871-0544", ...o,
})!;

test("normNome tira acento, número e pontuação", () => {
  assert.equal(normNome("Clínica de Saúde e Imagem - Unidade 2"), "CLINICA DE SAUDE E IMAGEM UNIDADE");
});

test("telefones: máscara, DDI, vários números e sem DDD", () => {
  assert.deepEqual(fonesDaLinha("(71) 98871-0544"), ["88710544"]);
  assert.deepEqual(fonesDaLinha("+55 71 98871-0544 / 71 3333-4444"), ["88710544", "33334444"]);
  assert.deepEqual(fonesDaLinha("98871-0544"), ["88710544"]);
  assert.deepEqual(fonesDaLinha("123"), []);
  assert.ok(fonesDaLinha("7198871054471333344449").includes("88710544"));
});

test("nomeConfere igual ao do banco", () => {
  assert.ok(nomeConfere("Alisson Cruz", "Alisson Oliveira da Cruz"));
  assert.ok(!nomeConfere("Maria", "Maria Silva"));
  assert.ok(!nomeConfere("Ana Souza", "Ana Lima"));
  assert.ok(nomeConfere("JOSÉ  da Silva", "Jose da Silva"));
});

test("linha sem data, médico ou unidade é descartada", () => {
  assert.equal(linhaDe({ Data_Atendimento: "", Medico: "X", Unidade: "Y" }), null);
  assert.equal(linhaDe({ Data_Atendimento: "2026-11-06 10:00:00", Medico: "", Unidade: "Y" }), null);
});

test("ok: mesmo horário, sala, unidade, exame e telefone", () => {
  const r = avaliar(alvo(), [linha()]);
  assert.deepEqual(r.slots, [{ idx: 0, r: "ok" }]);
  assert.equal(r.via, "ambos");
  assert.equal(r.div, null);
});

test("ok só pelo telefone, ou só pelo nome", () => {
  assert.equal(avaliar(alvo(), [linha({ Paciente: "Fulana Outra" })]).via, "telefone");
  assert.equal(avaliar(alvo(), [linha({ Telefone: "" })]).via, "nome");
});

test("horário ocupado por outra pessoa vira 'outro'", () => {
  const r = avaliar(alvo(), [linha({ Paciente: "Beltrano de Tal", Telefone: "(71) 91111-2222" })]);
  assert.deepEqual(r.slots, [{ idx: 0, r: "outro" }]);
  assert.equal(r.via, null);
});

test("horário livre quando nada está marcado", () => {
  assert.deepEqual(avaliar(alvo(), []).slots, [{ idx: 0, r: "livre" }]);
  assert.deepEqual(avaliar(alvo(), [linha({ Data_Atendimento: "2026-11-06T11:00:00", Paciente: "Outro", Telefone: "" })]).slots, [{ idx: 0, r: "livre" }]);
});

test("exame diferente no mesmo horário não confirma e avisa", () => {
  const r = avaliar(alvo(), [linha({ Procedimento: "ULTRASSONOGRAFIA DE ABDOME" })]);
  assert.equal(r.slots[0].r, "outro");
  assert.match(r.div ?? "", /outro exame: ULTRASSONOGRAFIA DE ABDOME/);
});

test("paciente com o mesmo exame em outro horário: divergência com data e sala", () => {
  const r = avaliar(alvo(), [linha({ Data_Atendimento: "2026-11-06T14:30:00" })]);
  assert.equal(r.slots[0].r, "livre");
  assert.match(r.div ?? "", /06\/11 14:30 \(Dr Joao Lima, CLÍNICA DE SAÚDE E IMAGEM - UNIDADE A\)/);
});

test("ordem de chegada: qualquer hora do dia vale e nunca é 'outro'", () => {
  const a = alvo({ slots: [{ idx: 0, data: "2026-11-06", hora: "07:00", prof: "DR JOAO LIMA", unidade: "CLINICA DE SAUDE E IMAGEM UNIDADE A", chegada: true, min: 5 }] });
  assert.equal(avaliar(a, [linha({ Data_Atendimento: "2026-11-06T09:20:00" })]).slots[0].r, "ok");
  assert.equal(avaliar(a, [linha({ Data_Atendimento: "2026-11-06T09:20:00", Paciente: "Outro Nome", Telefone: "" })]).slots[0].r, "livre");
});

test("vários horários: só confirma se todos baterem, e usa o vínculo mais fraco", () => {
  const a = alvo({ slots: [
    { idx: 0, data: "2026-11-06", hora: "10:00", prof: "DR JOAO LIMA", unidade: "CLINICA DE SAUDE E IMAGEM UNIDADE A", chegada: false, min: 30 },
    { idx: 1, data: "2026-11-06", hora: "11:00", prof: "DR JOAO LIMA", unidade: "CLINICA DE SAUDE E IMAGEM UNIDADE A", chegada: false, min: 30 }] });
  const r = avaliar(a, [linha(), linha({ Data_Atendimento: "2026-11-06T11:00:00", Paciente: "Outro", Telefone: "(71) 98871-0544" })]);
  assert.deepEqual(r.slots.map((s) => s.r), ["ok", "ok"]);
  assert.equal(r.via, "telefone");
  assert.deepEqual(avaliar(a, [linha()]).slots.map((s) => s.r), ["ok", "livre"]);
});

test("pedido sem exame definido não exige exame, mas também não gera divergência", () => {
  const a = alvo({ procs: [] });
  const r = avaliar(a, [linha({ Procedimento: "QUALQUER COISA", Data_Atendimento: "2026-11-06T15:00:00" })]);
  assert.equal(r.slots[0].r, "livre");
  assert.equal(r.div, null);
  assert.equal(avaliar(a, [linha({ Procedimento: "QUALQUER COISA" })]).slots[0].r, "ok");
});

test("o resultado não carrega nome nem telefone do Klingo", () => {
  const r = JSON.stringify(avaliar(alvo(), [linha(), linha({ Data_Atendimento: "2026-11-06T14:30:00", Paciente: "Fulano Raro", Telefone: "(71) 90000-1111" })]));
  assert.ok(!/Ana Maria|Fulano|98871|90000/.test(r));
});

test("escolherAlvos respeita o limite de dias e não perde ninguém quando cabe", () => {
  const mk = (id: string, data: string): Alvo => alvo({ id, slots: [{ idx: 0, data, hora: "10:00", prof: "P", unidade: "U", chegada: false, min: 30 }] });
  const muitos = Array.from({ length: 12 }, (_, i) => mk("a" + i, `2026-11-${String(i + 1).padStart(2, "0")}`));
  const esc = escolherAlvos(muitos, 8);
  assert.equal(new Set(esc.flatMap((a) => a.slots.map((s) => s.data))).size, 8);
  assert.equal(escolherAlvos(muitos.slice(0, 5), 8).length, 5);
  assert.equal(escolherAlvos([mk("x", "2026-11-01"), mk("y", "2026-11-01")], 1).length, 2);
});
