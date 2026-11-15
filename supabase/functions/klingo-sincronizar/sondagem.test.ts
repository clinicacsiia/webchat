// FLUXOGRAMA: entrada (um Klingo de mentira que responde por janela e por sexo) -> validação (sondarExame e janelas de sondagem.ts) -> lógica (45 dias em 3 janelas de 15; para no primeiro horário; "vazio" só com todas as janelas respondidas; erro e limite nunca viram "vazio") -> saída (node --test)
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial. Dados inventados.
import assert from "node:assert/strict";
import test from "node:test";
import { KlingoErro } from "./klingo-api.ts";
import type { Horario, PedidoHorarios } from "./klingo-api.ts";
import { janelas, sondarExame } from "./sondagem.ts";

const h = (data: string): Horario => ({ id: `${data}|1|1|1|08:00`, data, hora: "08:00", procedimento: null, ordem_chegada: false, faixa_ordem_chegada: null, profissional: null, unidade: null });
type Regra = (p: PedidoHorarios) => Horario[] | Error;
const falso = (regra: Regra) => { const chamadas: PedidoHorarios[] = []; return { chamadas, horarios: async (p: PedidoHorarios) => { chamadas.push(p); const r = regra(p); if (r instanceof Error) throw r; return r; } }; };
const HOJE = "2026-11-15";

test("as janelas cobrem 45 dias seguidos, 15 por vez (o Klingo recusa mais que isso)", () => {
  assert.deepEqual(janelas(HOJE), [["2026-11-15", "2026-11-29"], ["2026-11-30", "2026-12-14"], ["2026-12-15", "2026-12-29"]]);
});

test("horário já na primeira janela: 1 chamada só e devolve o primeiro dia", async () => {
  const api = falso(() => [h("2026-11-17")]);
  assert.deepEqual(await sondarExame(api, 1341, HOJE), { tipo: "tem", primeiro: "2026-11-17" });
  assert.equal(api.chamadas.length, 1);
  assert.equal(api.chamadas[0].exame, "1341");
  assert.equal(api.chamadas[0].sexo, "F");
});

test("horário só na terceira janela (agenda de sábado fora dos próximos 14 dias) NÃO some do chat", async () => {
  const api = falso((p) => (p.inicio === "2026-12-15" ? [h("2026-12-19")] : []));
  assert.deepEqual(await sondarExame(api, 1659, HOJE), { tipo: "tem", primeiro: "2026-12-19" });
});

test("horário só para o sexo masculino: acha na segunda tentativa da mesma janela", async () => {
  const api = falso((p) => (p.sexo === "M" ? [h("2026-11-16")] : []));
  assert.deepEqual(await sondarExame(api, 7, HOJE), { tipo: "tem", primeiro: "2026-11-16" });
  assert.deepEqual(api.chamadas.map((c) => c.sexo), ["F", "M"]);
});

test("sem horário em nenhuma das 3 janelas e nos dois sexos: vazio (6 chamadas)", async () => {
  const api = falso(() => []);
  assert.deepEqual(await sondarExame(api, 1659, HOJE), { tipo: "vazio" });
  assert.equal(api.chamadas.length, 6);
});

test("nenhum médico credenciado: vazio já na primeira janela (não gasta cota à toa)", async () => {
  const api = falso(() => new KlingoErro(403, "/agenda/horarios", "sem_medico"));
  assert.deepEqual(await sondarExame(api, 8, HOJE), { tipo: "vazio" });
  assert.equal(api.chamadas.length, 2);
});

test("erro do Klingo no meio (servidor, tempo esgotado) NUNCA vira vazio: o exame é pulado e fica como estava", async () => {
  const api = falso((p) => (p.inicio === "2026-11-30" ? new KlingoErro(500, "/agenda/horarios", "servidor") : []));
  const r = await sondarExame(api, 9, HOJE);
  assert.equal(r.tipo, "pular");
});

test("só um dos sexos respondeu: não dá para afirmar vazio", async () => {
  const api = falso((p) => (p.sexo === "M" ? new KlingoErro(0, "/agenda/horarios", "timeout") : []));
  assert.equal((await sondarExame(api, 9, HOJE)).tipo, "pular");
});

test("limite (429): para na hora, sem gravar nada", async () => {
  const api = falso(() => new KlingoErro(429, "/agenda/horarios", "limite"));
  assert.deepEqual(await sondarExame(api, 9, HOJE), { tipo: "limite" });
  assert.equal(api.chamadas.length, 1);
});

test("nada de paciente de verdade: sexo e nascimento são os de mentira", async () => {
  const api = falso(() => []);
  await sondarExame(api, 1, HOJE);
  assert.ok(api.chamadas.every((c) => c.nascimento === "1985-06-15" && (c.sexo === "F" || c.sexo === "M")));
});
