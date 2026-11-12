// Testes com dados INVENTADOS e `fetch` simulado (nenhuma chamada real ao Klingo, nenhum paciente real).
import test from "node:test";
import assert from "node:assert/strict";
import { cpfDigitos, dataIso, KlingoApi, KlingoErro, normalizarHorarios } from "./api.ts";

type Chamada = { url: string; init: RequestInit };
function falso(respostas: Array<[number, unknown]>) {
  const chamadas: Chamada[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    chamadas.push({ url, init });
    const [status, corpo] = respostas.shift() ?? [500, ""];
    return new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), { status });
  };
  return { f, chamadas };
}

// Mesmo formato da resposta real de 12/11/2026 (nomes e números inventados).
const DIA = {
  id: "2026-11-16|3|2|1", data: "2026-11-16", procedimento: 1096, ordem_chegada: false, faixa_ordem_chegada: null,
  horarios: { "2026-11-16|3|2|1|08:00": "08:00", "2026-11-16|3|2|1|08:30": "08:30" },
  profissional: { id: 3, tratamento: "Dr(a).", nome: "Dra. Teste", conselho: "CRM", numero: 1234, uf: "BA", foto: null },
  unidade: { id: 1, nome: "Unidade Teste", cnes: null, sigla: "UT" },
};

test("normalizarHorarios: mapa {id: hora}, mapa {hora: id} e lista de horas", () => {
  const a = normalizarHorarios({ horarios: [DIA] });
  assert.deepEqual(a.map((h) => [h.id, h.hora]), [["2026-11-16|3|2|1|08:00", "08:00"], ["2026-11-16|3|2|1|08:30", "08:30"]]);
  assert.equal(a[0].profissional?.nome, "Dra. Teste");
  assert.equal(a[0].unidade?.id, "1");
  assert.equal(a[0].unidade?.sigla, "UT");
  assert.equal(a[0].unidade?.cnes, null);
  assert.equal(a[0].procedimento, "1096");
  const b = normalizarHorarios({ horarios: [{ ...DIA, horarios: { "09:00": "chave-9" } }] });
  assert.deepEqual([b[0].id, b[0].hora], ["chave-9", "09:00"]);
  const c = normalizarHorarios({ horarios: [{ ...DIA, horarios: ["10:00:00"] }] });
  assert.deepEqual([c[0].id, c[0].hora], ["2026-11-16|3|2|1|10:00:00", "10:00"]);
});
test("normalizarHorarios: resposta vazia ou estranha vira lista vazia e ordena por data e hora", () => {
  assert.deepEqual(normalizarHorarios(null), []);
  assert.deepEqual(normalizarHorarios({ horarios: "x" }), []);
  const o = normalizarHorarios({ horarios: [{ ...DIA, data: "2026-11-17", horarios: ["07:00"] }, DIA] });
  assert.deepEqual(o.map((h) => h.data + h.hora), ["2026-11-1608:00", "2026-11-1608:30", "2026-11-1707:00"]);
});

test("horarios: manda X-APP-TOKEN, filtros na query e nenhuma sessão", async () => {
  const { f, chamadas } = falso([[200, { procedimento: "CONS", horarios: [DIA] }]]);
  const r = await new KlingoApi("TOKEN-X", f).horarios({ especialidade: "225265", inicio: "2026-11-16", fim: "2026-11-20", cnes: "999", plano: 7, revisao: false });
  assert.equal(r.length, 2);
  const u = new URL(chamadas[0].url);
  assert.equal(u.pathname, "/api/agenda/horarios");
  assert.equal(u.searchParams.get("especialidade"), "225265");
  assert.equal(u.searchParams.get("revisao"), "0");
  assert.equal(u.searchParams.get("plano"), "7");
  const h = chamadas[0].init.headers as Record<string, string>;
  assert.equal(h["X-APP-TOKEN"], "TOKEN-X");
  assert.equal(h.Authorization, undefined);
});
test("horarios: sem especialidade nem exame não chama a API", async () => {
  const { f, chamadas } = falso([]);
  await assert.rejects(new KlingoApi("T", f).horarios({}), /especialidade/);
  assert.equal(chamadas.length, 0);
});

test("login: precede o id com P e devolve o access_token", async () => {
  const { f, chamadas } = falso([[200, { access_token: "SESSAO-1" }]]);
  assert.equal(await new KlingoApi("T", f).login(123), "SESSAO-1");
  assert.equal(chamadas[0].init.method, "POST");
  assert.deepEqual(JSON.parse(String(chamadas[0].init.body)), { id: "P123" });
});
test("login: resposta sem token é erro", async () => {
  const { f } = falso([[200, {}]]);
  await assert.rejects(new KlingoApi("T", f).login(1), KlingoErro);
});

test("reservar e marcar: usam a sessão como Bearer e o corpo do Swagger", async () => {
  const { f, chamadas } = falso([[200, { id: 55, expira: "2026-11-16 08:10" }], [200, { id: "9001", status: "agendado" }]]);
  const api = new KlingoApi("T", f);
  const m = { horario: "2026-11-16|3|2|1|08:00", procedimento: "1000", plano: 7, idExterno: "pedido-1" };
  assert.equal((await api.reservar("S", m)).id, 55);
  assert.equal((await api.marcar("S", m)).id, "9001");
  assert.equal(new URL(chamadas[0].url).pathname, "/api/agenda/reservar");
  assert.equal(new URL(chamadas[1].url).pathname, "/api/agenda/horario");
  assert.equal((chamadas[1].init.headers as Record<string, string>).Authorization, "Bearer S");
  assert.deepEqual(JSON.parse(String(chamadas[1].init.body)), { id: m.horario, procedimento: "1000", plano: 7, email: false, id_externo: "pedido-1" });
});
test("cancelarReserva: DELETE com o id numérico", async () => {
  const { f, chamadas } = falso([[200, {}]]);
  await new KlingoApi("T", f).cancelarReserva("S", "55");
  assert.equal(chamadas[0].init.method, "DELETE");
  assert.deepEqual(JSON.parse(String(chamadas[0].init.body)), { id: 55 });
});

test("erro do Klingo: só status e caminho, nunca o corpo (pode ter dado de paciente)", async () => {
  const { f } = falso([[403, { message: "Paciente FULANO DE TESTE inválido" }]]);
  await assert.rejects(new KlingoApi("T", f).pacientePorCpf("12345678909"), (e: unknown) => {
    assert.ok(e instanceof KlingoErro);
    assert.equal(e.status, 403);
    assert.ok(!e.message.includes("FULANO"));
    return true;
  });
});
test("versao: resposta em texto puro", async () => {
  const { f } = falso([[200, "OK [API1]"]]);
  assert.equal(await new KlingoApi("T", f).versao(), "OK [API1]");
});

test("cpfDigitos e dataIso", () => {
  assert.equal(cpfDigitos("123.456.789-09"), "12345678909");
  assert.equal(cpfDigitos("123"), null);
  assert.equal(dataIso("17/05/1990"), "1990-05-17");
  assert.equal(dataIso("1990-05-17T00:00:00"), "1990-05-17");
  assert.equal(dataIso("1990-02-31"), null);
  assert.equal(dataIso("x"), null);
});
