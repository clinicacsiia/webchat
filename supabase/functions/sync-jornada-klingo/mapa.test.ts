// Testes com dados INVENTADOS (nenhum paciente real). Colunas do #14359 achadas pelo título.
import test from "node:test";
import assert from "node:assert/strict";
import { LAYOUT_EXAME, LAYOUT_CRIACAO, TITULOS_EXAME, checkinSuspeito, layoutPorTitulos, layoutSuspeito, lerCheckin, mapearLinha, layoutDe, prepararLinhas } from "./mapa.ts";

const SAL = "segredo-de-teste";
// Ordem real devolvida pelo Klingo em 15/11/2026 (21 colunas; "Prontuário" aparece duas vezes).
const ORDEM_REAL = ["Id da Marcação", "Id do Atendimento", "Paciente - Nome", "Responsável", "Prontuário", "Data Agendado Em", "Data Agendado Para", "Procedimento", "Operadora", "Unidade", "Valor", "Observação", "Confirm Status", "Cancelamento - Motivo", "Paciente - Telefone", "Status", "Paciente - Celular", "Atendido", "Check-In - Data", "Prontuário", "Primeira Vez"];
const colunas = (titulos: string[]) => titulos.map((title, i) => ({ name: `col${i}`, title }));
const VALORES: Record<string, string> = {
  "Id da Marcação": "9001", "Id do Atendimento": "777", "Paciente - Nome": "Fulana de Teste", "Responsável": "usuario.teste", "Prontuário": "123456",
  "Data Agendado Em": "2026-11-10 09:00:00", "Data Agendado Para": "2026-11-16 08:00:00", "Procedimento": "CONSULTA", "Operadora": "Particular", "Unidade": "CLÍNICA DE SAÚDE E IMAGEM - CSI",
  "Valor": "100", "Observação": "", "Confirm Status": "Confirmado", "Cancelamento - Motivo": "", "Paciente - Telefone": "", "Status": "Aberta", "Paciente - Celular": "71999990001",
  "Atendido": "S", "Check-In - Data": "2026-11-16 07:50:00", "Primeira Vez": "N",
};
// Monta uma linha no formato do Klingo (col0..colN) para a ordem de títulos dada.
const linha = (titulos: string[], o: Record<string, string> = {}) => Object.fromEntries(titulos.map((t, i) => [`col${i}`, o[t] ?? VALORES[t] ?? ""]));

test("ordem real do Klingo: acha tudo e bate com a ordem fixa atual", () => {
  const r = layoutPorTitulos(colunas(ORDEM_REAL), LAYOUT_EXAME);
  assert.deepEqual(r.faltando, []);
  assert.deepEqual(r.diferenteDoFixo, []);
  assert.equal(r.layout.cel, "col16");
  assert.equal(r.layout.atend, "col17");
  assert.equal(r.layout.pront, "col4", "título repetido: vale a coluna de menor número");
  assert.equal(r.layout.checkin, "col18");
  assert.equal(r.layout.primeira, "col20");
});

test("colunas embaralhadas e uma nova no meio: a leitura continua certa", async () => {
  const embaralhada = ["Atendido", "Paciente - Celular", "Coluna Nova Qualquer", ...ORDEM_REAL.filter((t) => t !== "Atendido" && t !== "Paciente - Celular").reverse()];
  const r = layoutPorTitulos(colunas(embaralhada), LAYOUT_EXAME);
  assert.deepEqual(r.faltando, []);
  assert.equal(r.layout.atend, "col0");
  assert.equal(r.layout.cel, "col1");
  assert.ok(r.diferenteDoFixo.includes("atend") && r.diferenteDoFixo.includes("cel"));
  const l = (await mapearLinha(linha(embaralhada), SAL, r.layout))!;
  assert.equal(l.t, "S", "Atendido lido da coluna certa");
  assert.equal(l.m, "9001");
  assert.equal(l.a, "777");
  assert.equal(l.f.length, 64, "telefone virou marca");
  assert.equal(l.s, "Aberta");
  assert.equal(layoutSuspeito([...Array(30)].map(() => linha(embaralhada)), r.layout), null);
});

test("sem a lista de títulos certa, a ordem fixa antiga leria errado e a trava pega", () => {
  const embaralhada = ["Atendido", "Paciente - Celular", ...ORDEM_REAL.filter((t) => t !== "Atendido" && t !== "Paciente - Celular")];
  const linhas = [...Array(30)].map(() => linha(embaralhada));
  assert.match(layoutSuspeito(linhas, LAYOUT_EXAME) ?? "", /Layout do relatório mudou/);
});

test("título obrigatório renomeado: devolve qual sumiu (a leitura para)", () => {
  const renomeada = ORDEM_REAL.map((t) => (t === "Atendido" ? "Foi atendido" : t));
  const r = layoutPorTitulos(colunas(renomeada), LAYOUT_EXAME);
  assert.deepEqual(r.faltando, ["Atendido"]);
});

test("maiúscula, acento e espaço a mais no título não atrapalham", () => {
  const sujo = ORDEM_REAL.map((t) => (t === "Id da Marcação" ? "  ID DA MARCACAO " : t === "Data Agendado Para" ? "data  agendado para" : t));
  const r = layoutPorTitulos(colunas(sujo), LAYOUT_EXAME);
  assert.deepEqual(r.faltando, []);
  assert.equal(r.layout.m, "col0");
  assert.equal(r.layout.d, "col6");
});

test("colunas opcionais ausentes (check-in, primeira vez, responsável) não bloqueiam", () => {
  const sem = ORDEM_REAL.filter((t) => t !== "Check-In - Data" && t !== "Primeira Vez" && t !== "Responsável");
  const r = layoutPorTitulos(colunas(sem), LAYOUT_EXAME);
  assert.deepEqual(r.faltando, []);
  assert.equal(r.layout.checkin, undefined);
});

test("lista vazia ou sem nomes válidos: tudo que é obrigatório aparece como faltando", () => {
  const obrigatorios = Object.keys(TITULOS_EXAME).filter((k) => !["resp", "checkin", "primeira"].includes(k)).length;
  assert.equal(layoutPorTitulos([], LAYOUT_EXAME).faltando.length, obrigatorios);
  assert.equal(layoutPorTitulos([{ name: "x", title: "Atendido" }, { title: "Status" }], LAYOUT_EXAME).faltando.length, obrigatorios);
});

test("o #13825 (criação) continua pela ordem fixa", () => {
  assert.equal(layoutDe("criacao").atend, "col13");
  assert.equal(layoutDe("exame").atend, "col17");
});

// ---------------------------------------------------------------- check-in (col18)
test("lerCheckin: ISO, ISO com T, sem segundos e o formato da planilha viram AAAA-MM-DD HH:MM:SS", () => {
  assert.deepEqual(lerCheckin("2026-11-16 07:50:00"), { iso: "2026-11-16 07:50:00", invalido: false });
  assert.deepEqual(lerCheckin("2026-11-16T07:50"), { iso: "2026-11-16 07:50:00", invalido: false });
  assert.deepEqual(lerCheckin("16/11/2026 07:50"), { iso: "2026-11-16 07:50:00", invalido: false });
  assert.deepEqual(lerCheckin("  16/11/2026 07:50:09 "), { iso: "2026-11-16 07:50:09", invalido: false });
});

test("lerCheckin: vazio é sem check-in; texto que não é data é inválido e nunca vira data", () => {
  assert.deepEqual(lerCheckin(""), { iso: "", invalido: false });
  assert.deepEqual(lerCheckin(null), { iso: "", invalido: false });
  assert.deepEqual(lerCheckin(undefined), { iso: "", invalido: false });
  assert.deepEqual(lerCheckin("S"), { iso: "", invalido: true });
  assert.deepEqual(lerCheckin("71999990001"), { iso: "", invalido: true });
});

test("mapearLinha: com a coluna do check-in no layout manda k; sem ela (#13825) não manda a chave", async () => {
  const ordem = ORDEM_REAL;
  const r = layoutPorTitulos(colunas(ordem), LAYOUT_EXAME).layout;
  const l = (await mapearLinha(linha(ordem, { "Check-In - Data": "2026-11-16 07:50:00" }), SAL, r))!;
  assert.equal(l.k, "2026-11-16 07:50:00");
  const sem = (await mapearLinha(linha(ordem, { "Check-In - Data": "" }), SAL, r))!;
  assert.equal(sem.k, "", "sem check-in manda vazio (o banco limpa)");
  const antiga = (await mapearLinha({ col0: "9", col4: "2026-11-16 08:00:00", col2: "123", col15: "Fulana Teste", col16: "71999990001" }, SAL, LAYOUT_CRIACAO))!;
  assert.equal("k" in antiga, false, "relatório sem a coluna: a chave k nem existe");
});

test("mapearLinha: o check-in no formato da planilha também chega certo", async () => {
  const l = (await mapearLinha(linha(ORDEM_REAL, { "Check-In - Data": "16/11/2026 07:50" }), SAL, LAYOUT_EXAME))!;
  assert.equal(l.k, "2026-11-16 07:50:00");
});

test("prepararLinhas: conta check-ins lidos e inválidos, sem expor o conteúdo", async () => {
  const hoje = "2026-11-16";
  const linhas = [
    linha(ORDEM_REAL, { "Id da Marcação": "1", "Check-In - Data": "2026-11-16 07:50:00" }),
    linha(ORDEM_REAL, { "Id da Marcação": "2", "Check-In - Data": "" }),
    linha(ORDEM_REAL, { "Id da Marcação": "3", "Check-In - Data": "lixo" }),
  ];
  const r = await prepararLinhas(linhas, SAL, hoje, LAYOUT_EXAME);
  assert.equal(r.checkinLidos, 1);
  assert.equal(r.checkinInvalidos, 1);
  assert.equal(r.linhas.length, 3);
});

test("checkinSuspeito: poucos inválidos passam; coluna cheia de lixo é suspeita", () => {
  assert.equal(checkinSuspeito(500, 3), false);
  assert.equal(checkinSuspeito(0, 19), false, "menos de 20 inválidos: não decide");
  assert.equal(checkinSuspeito(10, 30), true);
  assert.equal(checkinSuspeito(900, 100), false, "10% inválido: ainda aceitável");
});
