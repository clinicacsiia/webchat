// FLUXOGRAMA: entrada (respostas INVENTADAS da API de horários do Klingo em cada situação) -> validação (diagnosticar / pedidoDaApi / estadoDoResultado) -> processamento (contagem por etapa) -> saída (asserts)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão. Prova que HTTP 200 não é "há horários": vazio, estrutura inesperada, tudo descartado e expirado são resultados diferentes.
// Nenhuma chamada de rede; nenhum dado de paciente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contarBrutos, diagnosticar, estadoDoResultado, pedidoDaApi, resultadoDoMotivo, somaDias } from "./oferta.ts";

const HOJE = "2026-11-14", AGORA = "10:00";
const dia = (data: string, horarios: unknown) => ({ data, id: 1, profissional: { id: "63", nome: "DRA EXEMPLO" }, unidade: { id: "2", nome: "CSI" }, procedimento: "1096", ordem_chegada: false, horarios });
const real = (data: string, ...horas: string[]) => dia(data, Object.fromEntries(horas.map((h) => [`${data}|63|308|2|${h}`, h])));   // formato real observado em 12/11/2026

test("A1 API retorna horários: ok_com_horarios com a contagem de cada etapa", () => {
  const d = diagnosticar({ horarios: [real("2026-11-16", "08:00", "08:30"), real("2026-11-17", "09:00")] }, HOJE, AGORA);
  assert.equal(d.resultado, "ok_com_horarios"); assert.equal(d.recebidos, 3); assert.equal(d.validos, 3); assert.equal(d.filtrados, 0); assert.equal(d.ofertas.length, 3);
  assert.equal(d.ofertas[0].chave, "2026-11-16|63|308|2|08:00"); assert.equal(d.ofertas[0].procedimento, 1096);
});
test("A2 API retorna lista vazia (HTTP 200): api_sem_horarios, NÃO é erro nem 'ok com horários'", () => {
  for (const r of [{ horarios: [] }, { horarios: [dia("2026-11-16", {})] }, { horarios: [dia("2026-11-16", [])] }]) {
    const d = diagnosticar(r, HOJE, AGORA); assert.equal(d.resultado, "api_sem_horarios"); assert.equal(d.recebidos, 0); assert.equal(d.ofertas.length, 0);
  }
  assert.equal(estadoDoResultado("api_sem_horarios"), "sem_horarios");
});
test("A3 API retorna dados inválidos / estrutura inesperada: estrutura_invalida (≠ vazio), estado indisponivel", () => {
  for (const r of [null, undefined, {}, "<html>erro</html>", 42, { horarios: "x" }, { horarios: { a: 1 } }, { data: [] }]) {
    const d = diagnosticar(r, HOJE, AGORA); assert.equal(d.resultado, "estrutura_invalida", JSON.stringify(r)); assert.equal(contarBrutos(r), null);
  }
  assert.equal(estadoDoResultado("estrutura_invalida"), "indisponivel");
});
test("A4 horários recebidos mas TODOS filtrados: todos_filtrados com recebidos > 0 (passado, hoje já passou, hora ou chave inválida)", () => {
  const d = diagnosticar({ horarios: [real("2026-11-13", "08:00"), real(HOJE, "09:00", "10:00"), dia("2026-11-20", { "k1": "xx:yy", "k2": "8h" })] }, HOJE, AGORA);
  assert.equal(d.resultado, "todos_filtrados"); assert.equal(d.recebidos, 5); assert.equal(d.ofertas.length, 0); assert.ok(d.filtrados >= 5 - 0);
  assert.equal(estadoDoResultado("todos_filtrados"), "sem_horarios");
});
test("A5 horário EXPIRADO hoje: só vale o que ainda não passou; o resto da lista continua", () => {
  const d = diagnosticar({ horarios: [real(HOJE, "09:30", "10:00", "10:30", "15:00")] }, HOJE, AGORA);
  assert.deepEqual(d.ofertas.map((o) => o.hora), ["10:30", "15:00"]); assert.equal(d.resultado, "ok_com_horarios"); assert.equal(d.filtrados, 2);
});
test("A6 duplicata não vira duas ofertas (mesma chave)", () => {
  const d = diagnosticar({ horarios: [real("2026-11-16", "08:00"), real("2026-11-16", "08:00")] }, HOJE, AGORA);
  assert.equal(d.recebidos, 2); assert.equal(d.validos, 1); assert.equal(d.ofertas.length, 1);
});
test("A7 formato de lista de objetos também é lido (variação da API)", () => {
  const d = diagnosticar({ horarios: [dia("2026-11-16", [{ id: "2026-11-16|63|308|2|08:00", hora: "08:00" }, "09:00"])] }, HOJE, AGORA);
  assert.equal(d.resultado, "ok_com_horarios"); assert.equal(d.ofertas.length, 2);
});
test("A8 limite de ofertas guardadas", () => {
  const muitos = real("2026-12-01", ...Array.from({ length: 50 }, (_, i) => `${String(8 + Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`));
  assert.equal(diagnosticar({ horarios: [muitos] }, HOJE, AGORA, 10).ofertas.length, 10);
});
test("A9 procedimento sem integração: a conversa não vai para a API (pedidoDaApi nulo); vários exames também não", () => {
  const base = { tipo: "consulta", plano: "PARTICULAR", procedimento: 777, n_procedimentos: 1, cpf: null, nascimento: null, sexo: null, identidade: null };
  const esp = [{ cbos: "225125", procedimentos: [1096, 1472] }];
  assert.equal(pedidoDaApi(base, esp), null);                                                         // consulta de especialidade que a API não oferece
  assert.deepEqual(pedidoDaApi({ ...base, procedimento: 1096 }, esp), { especialidade: "225125" });
  assert.deepEqual(pedidoDaApi({ ...base, tipo: "exame", procedimento: 5001 }, []), { exame: "5001" });
  assert.equal(pedidoDaApi({ ...base, tipo: "exame", procedimento: 5001, n_procedimentos: 2 }, []), null);   // múltiplos exames: sem operação composta
  assert.equal(pedidoDaApi({ ...base, tipo: "exame", procedimento: null }, []), null);
});
test("A10 motivos técnicos viram resultados do registro (convênio sem tradução, plano inativo, limite, indisponível)", () => {
  assert.equal(resultadoDoMotivo("limite"), "limite"); assert.equal(resultadoDoMotivo("indisponivel"), "erro_api"); assert.equal(resultadoDoMotivo("sem_chave"), "erro_api");
  for (const m of ["sem_traducao", "plano_inativo", "plano_desconhecido", "sem_medico", "plano_do_cadastro_necessario"]) { assert.equal(resultadoDoMotivo(m), "sem_traducao_plano"); assert.equal(estadoDoResultado(resultadoDoMotivo(m)), "nao_integrado"); }
  assert.equal(estadoDoResultado("erro_api"), "indisponivel"); assert.equal(estadoDoResultado("limite"), "indisponivel"); assert.equal(estadoDoResultado("erro_gravacao"), "indisponivel");
  assert.equal(estadoDoResultado("fora_do_escopo"), "nao_integrado");
});
test("A11 janelas de 15 dias seguidas (limite da API) não se sobrepõem", () => {
  assert.equal(somaDias(HOJE, 0), "2026-11-14"); assert.equal(somaDias(somaDias(HOJE, 0), 14), "2026-11-28"); assert.equal(somaDias(HOJE, 15), "2026-11-29");
});
