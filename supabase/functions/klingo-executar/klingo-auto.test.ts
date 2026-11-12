// Testes do autoatendimento com um KLINGO DE MENTIRA (dados inventados, nenhuma chamada de rede).
// Rodar: cd testes && npm run test:edge
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classificar, cotaGlobal, KlingoApi, KlingoErro, resumoPaciente } from "./klingo-api.ts";
import { acharVoucher, executar, executarCancelamento, executarMarcacao, type Pegar, type Rpc } from "./executor.ts";
import { identificar } from "../klingo-identificar/identificar.ts";
import { KlingoApi as KlingoApiIdent } from "../klingo-identificar/klingo-api.ts";   // cada função usa a própria cópia (classe de erro própria)
import { montarOfertas, pedidoDaApi } from "../chat-agenda-api/oferta.ts";

const CPF = "11144477735", NASC = "1980-03-25";
const CHAVE = "2026-11-20|63|308|2|09:40";
const OP = "11111111-1111-4111-8111-111111111111";

// ------------------------------------------------------------------ o Klingo de mentira
type Cena = {
  paciente?: Record<string, unknown> | null;              // resposta de /paciente/cpf (null = 403 não identificado)
  loginUser?: Record<string, unknown>;                    // o que a sessão devolve (para testar sessão errada)
  horarios?: string[];                                    // chaves ainda livres
  reservar?: "ok" | "ocupado";
  marcar?: "ok" | "ocupado" | "timeout" | "html500" | "plano_inativo" | "sem_voucher";
  vouchers?: Array<Record<string, unknown>>;
  vouchersDepoisDeCancelar?: Array<Record<string, unknown>>;   // o que a lista mostra depois do DELETE /voucher
  cancelar?: "ok" | "timeout" | "ja_cancelado";
  register?: "ok" | "timeout";
  limiteNaPrimeira?: boolean;
};
function klingo(c: Cena) {
  const chamadas: string[] = []; const corpos: Array<{ rota: string; corpo: any }> = [];
  let jaDeu429 = false, cancelou = false;
  const resp = (status: number, corpo: unknown, tipo = "application/json") => new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), { status, headers: { "content-type": tipo } });
  const f = async (url: string, init?: RequestInit) => {
    const u = new URL(url); const rota = `${init?.method ?? "GET"} ${u.pathname.replace("/api", "")}`; chamadas.push(rota);
    const corpo = init?.body ? JSON.parse(String(init.body)) : undefined; corpos.push({ rota, corpo });
    if (c.limiteNaPrimeira && !jaDeu429 && rota.startsWith("GET /agenda/horarios")) { jaDeu429 = true; return resp(429, "<html>429</html>", "text/html"); }
    if (rota === "GET /paciente/cpf") return c.paciente ? resp(200, c.paciente) : resp(403, { msg: `Paciente não identificado: . ${u.searchParams.get("cpf")}`, code: "PACIENTE_NAO_IDENTIFICADO" });
    if (rota === "POST /externo/register") { if (c.register === "timeout") { const e = new Error("t"); e.name = "TimeoutError"; throw e; } return resp(200, { id: 7960 }); }
    if (rota === "POST /externo/login") return resp(200, { access_token: "tok", user: c.loginUser ?? { id: corpo.id, nome: "Maria Teste", nascimento: NASC, id_paciente: String(corpo.id).startsWith("P") ? "1" : "" } });
    if (rota === "GET /agenda/horarios") return resp(200, { horarios: [{ id: "x", data: "2026-11-20", procedimento: 1096, profissional: { id: 63, nome: "GEANNE CHRISTINA PINHEIRO" }, unidade: { id: 2, nome: "DESENVOAR" },
      horarios: Object.fromEntries((c.horarios ?? [CHAVE]).map((k) => [k, k.split("|")[4]])) }] });
    if (rota === "POST /agenda/reservar") return c.reservar === "ocupado" ? resp(403, { msg: "Horário já ocupado. [reservado 2026-11-20 09:40/6901]" }) : resp(200, { id: 555, expira: "2026-11-20 09:50:00" });
    if (rota === "DELETE /agenda/reservar") return resp(200, { status: "ok" });
    if (rota === "POST /agenda/horario") {
      if (c.marcar === "timeout") { const e = new Error("t"); e.name = "TimeoutError"; throw e; }
      if (c.marcar === "html500") return resp(500, "<html>erro</html>", "text/html");
      if (c.marcar === "ocupado") return resp(400, { msg: "Horário já ocupado. …ID: 6901" });
      if (c.marcar === "plano_inativo") return resp(403, { msg: "Plano BRADESCO SAUDE inativado.", status_code: 403 });
      if (c.marcar === "sem_voucher") return resp(200, {});
      return resp(200, { id: 26700, status: "agendado", data: "2026-11-20", hora: "09:40:00", procedimento: { descr: "CONSULTA" }, unidade: { nome: "DESENVOAR" }, realizador: { nome: "GEANNE CHRISTINA PINHEIRO" }, id_externo: corpo.id_externo });
    }
    if (rota === "DELETE /voucher") {
      cancelou = true;
      if (c.cancelar === "timeout") { const e = new Error("t"); e.name = "TimeoutError"; throw e; }
      return c.cancelar === "ja_cancelado" ? resp(403, { msg: "Agendamento já cancelado." }) : resp(200, { status: "ok" });
    }
    if (rota === "GET /vouchers") return resp(200, cancelou && c.vouchersDepoisDeCancelar ? c.vouchersDepoisDeCancelar : (c.vouchers ?? []));
    return resp(404, "nao");
  };
  return { f, chamadas, corpos };
}
const semEspera = { esperar: async () => {} };
const apiDe = (c: Cena, extra: Record<string, unknown> = {}) => { const k = klingo(c); return { k, api: new KlingoApi("clinicacsi:segredo", k.f, { ...semEspera, ...extra }) }; };

function rpcDe(o: { preCadastro?: boolean; pre?: { acao: string; klingo_id?: string }; plano?: number | null; gravados?: unknown[] } = {}) {
  const gravados: Array<{ nome: string; args: any }> = [];
  const rpc: Rpc = async (nome, args) => {
    gravados.push({ nome, args });
    if (nome === "klingo_ativo") return { data: o.preCadastro ?? false };
    if (nome === "klingo_plano_resolver") return { data: o.plano === null ? { plano_id: null, motivo: "sem_traducao" } : { plano_id: o.plano ?? 1, via: "padrao" } };
    if (nome === "klingo_pre_reservar") return { data: o.pre ?? { acao: "criar" } };
    return { data: null };
  };
  return { rpc, gravados };
}
const pegar = (extra: Partial<Pegar["dados"]> = {}): Pegar => ({
  operacao: { id: OP, tipo: "marcar", conversa_id: "22222222-2222-4222-8222-222222222222", detalhe: { chave: CHAVE } },
  dados: { tipo: "consulta", plano: "Particular", procedimento: 1096, cpf: CPF, nascimento: NASC, nome: "Maria Teste", sexo: "F", celular: "71999990001", email: null, identidade: null, ...extra },
  oferta: { chave: CHAVE, procedimento: 1096, plano: 1, data: "2026-11-20", hora: "09:40", profissional: "GEANNE CHRISTINA PINHEIRO" },
});
const ESPS = [{ cbos: "225112", procedimentos: [1096, 1472] }];
const PAC = { id: "P123", dt_nasc: NASC, nome: "MARIA TESTE", contatos: { celular: "71999990001", email: "" }, convenio: { id_plano: 1 } };

// ------------------------------------------------------------------ cliente da API
test("o erro nunca carrega o corpo da resposta (CPF/nome) e é classificado por tipo", async () => {
  const { api } = apiDe({ paciente: null });
  await assert.rejects(() => api.pacientePorCpf(CPF), (e: any) => e instanceof KlingoErro && e.tipo === "paciente_nao_identificado" && !e.message.includes(CPF) && !JSON.stringify(e).includes(CPF));
  assert.equal(classificar(403, "Plano BRADESCO SAUDE inativado."), "plano_inativo");
  assert.equal(classificar(403, "Plano BRADESCO SAUDE inativo."), "plano_inativo");
  assert.equal(classificar(403, '{"plano":["Plano não identificado."]}'), "plano_desconhecido");
  assert.equal(classificar(403, "Nenhum médico credenciado para CONSULTA (68), para operadora X."), "sem_medico");
  assert.equal(classificar(400, "Horário já ocupado. …"), "horario_ocupado");
  assert.equal(classificar(403, "Agendamento já cancelado."), "ja_cancelado");
  assert.equal(classificar(403, "<html>"), "html");
  assert.equal(classificar(503, "x"), "servidor");
});
test("429: espera e tenta de novo, avisa a cota global e funciona na segunda tentativa; sem sorte, vira erro 'limite'", async () => {
  let avisos = 0;
  const { api, k } = apiDe({ limiteNaPrimeira: true }, { aoLimite: () => { avisos++; } });
  const hs = await api.horarios({ exame: "1725" });
  assert.equal(hs.length, 1); assert.equal(avisos, 1); assert.equal(k.chamadas.filter((c) => c.startsWith("GET /agenda/horarios")).length, 2);
  const sempre = new KlingoApi("t", async () => new Response("<html>429</html>", { status: 429, headers: { "content-type": "text/html" } }), { ...semEspera, tentativas429: 2 });
  await assert.rejects(() => sempre.versao(), (e: any) => e.tipo === "limite" && e.incerto === true);
});
test("resposta HTML com status 200 não é lida como JSON (é erro)", async () => {
  const api = new KlingoApi("t", async () => new Response("<html>manutenção</html>", { status: 200, headers: { "content-type": "text/html" } }), semEspera);
  await assert.rejects(() => api.convenios(), (e: any) => e.tipo === "html");
});
test("cota global: pega a ficha, espera quando manda esperar e desiste (limite) se nunca libera", async () => {
  let n = 0; const esperas: number[] = [];
  await cotaGlobal(async () => ({ data: ++n < 3 ? { ok: false, espera_ms: 700 } : { ok: true } }), { esperar: async (ms) => { esperas.push(ms); } })();
  assert.deepEqual(esperas, [700, 700]);
  await assert.rejects(() => cotaGlobal(async () => ({ data: { ok: false, espera_ms: 100 } }), { maxTentativas: 3, esperar: async () => {} })(), (e: any) => e.tipo === "limite");
});
test("resumo do cadastro: só id, nascimento, o que falta e o plano (nenhum nome, telefone ou e-mail sai)", () => {
  const s = resumoPaciente({ id: "P9", nome: "FULANO", dt_nasc: "1980-03-25", contatos: { celular: "719", email: "", telefone: null }, convenio: { id_plano: 14 } });
  assert.deepEqual(s, { id: "P9", nascimento: "1980-03-25", faltando: ["email", "telefone"], planoId: 14 });
  assert.deepEqual(resumoPaciente({ id: "P9", convenio: { plano: { id: 28 } } }).planoId, 28);
  assert.deepEqual(resumoPaciente(null), { id: null, nascimento: null, faltando: ["email", "celular", "telefone"], planoId: null });
});
test("as 4 cópias do klingo-api.ts são idênticas (cada Edge Function publica a pasta isolada)", () => {
  const base = readFileSync(new URL("./klingo-api.ts", import.meta.url), "utf8");
  for (const f of ["klingo-identificar", "chat-agenda-api", "klingo-sincronizar"]) assert.equal(readFileSync(new URL(`../${f}/klingo-api.ts`, import.meta.url), "utf8"), base, f);
  assert.equal(readFileSync(new URL("../chat-agenda-api/identificar.ts", import.meta.url), "utf8"), readFileSync(new URL("../klingo-identificar/identificar.ts", import.meta.url), "utf8"));
});

// ------------------------------------------------------------------ conferência de CPF
test("identificar: confere, divergente, não encontrado, sem id definitivo e erro de rede", async () => {
  const ap = (c: Cena) => new KlingoApiIdent("t", klingo(c).f, semEspera);
  assert.equal((await identificar(ap({ paciente: PAC }), CPF, NASC)).situacao, "confere");
  assert.equal((await identificar(ap({ paciente: PAC }), CPF, "1981-03-25")).situacao, "divergente");
  assert.equal((await identificar(ap({ paciente: null }), CPF, NASC)).situacao, "nao_encontrado");
  assert.equal((await identificar(ap({ paciente: { ...PAC, id: "123" } }), CPF, NASC)).situacao, "sem_id_definitivo");
  assert.equal((await identificar(new KlingoApiIdent("t", async () => { throw new Error("rede"); }, semEspera), CPF, NASC)).situacao, "erro");
});

// ------------------------------------------------------------------ o executor
test("SUCESSO (paciente com cadastro): identidade -> plano -> sessão conferida -> horário existe -> reservar -> marcar com id_externo", async () => {
  const { api, k } = apiDe({ paciente: PAC }); const { rpc } = rpcDe();
  const r = await executarMarcacao(api, rpc, pegar(), ESPS);
  assert.equal(r.estado, "sucesso"); assert.equal(r.voucher?.id, "26700"); assert.equal(r.voucher?.hora, "09:40");
  assert.deepEqual(k.chamadas, ["GET /paciente/cpf", "POST /externo/login", "GET /agenda/horarios", "POST /agenda/reservar", "POST /agenda/horario"]);
  assert.equal(k.corpos.find((c) => c.rota === "POST /externo/login")!.corpo.id, "P123");   // o id EXATO, com o P
  const m = k.corpos.find((c) => c.rota === "POST /agenda/horario")!.corpo;
  assert.equal(m.id_externo, OP); assert.equal(m.email, false); assert.equal(m.procedimento, "1096"); assert.equal(m.plano, 1); assert.equal(m.id, CHAVE);
});
test("nascimento diferente do cadastro: NADA é marcado e nem faz login", async () => {
  const { api, k } = apiDe({ paciente: { ...PAC, dt_nasc: "1999-01-01" } }); const { rpc, gravados } = rpcDe();
  const r = await executarMarcacao(api, rpc, pegar(), ESPS);
  assert.equal(r.estado, "falha"); assert.equal(r.codigo, "nascimento_divergente");
  assert.ok(!k.chamadas.some((c) => c.includes("login") || c.includes("reservar") || c.includes("agenda/horario")));
  assert.ok(gravados.some((g) => g.nome === "klingo_identidade_registrar" && g.args.p_r.situacao === "divergente"));
});
test("sessão de outra pessoa (id, nascimento ou nome não batem): descarta, não reserva e não marca", async () => {
  for (const user of [{ id: "P999", nome: "Outra", nascimento: NASC }, { id: "P123", nome: "Maria", nascimento: "1970-01-01" }]) {
    const { api, k } = apiDe({ paciente: PAC, loginUser: user }); const { rpc } = rpcDe();
    const r = await executarMarcacao(api, rpc, pegar(), ESPS);
    assert.equal(r.codigo, "sessao_nao_confere"); assert.ok(!k.chamadas.some((c) => c.includes("reservar") || c.endsWith("/agenda/horario")));
  }
});
test("HORÁRIO TOMADO: some da lista antes de reservar, ou a reserva/marcação recusa 'já ocupado' (a reserva é solta)", async () => {
  let r = await executarMarcacao(apiDe({ paciente: PAC, horarios: ["2026-11-20|63|308|2|10:00"] }).api, rpcDe().rpc, pegar(), ESPS);
  assert.equal(r.estado, "horario_tomado");
  const a = apiDe({ paciente: PAC, reservar: "ocupado" }); r = await executarMarcacao(a.api, rpcDe().rpc, pegar(), ESPS);
  assert.equal(r.estado, "horario_tomado"); assert.ok(!a.k.chamadas.includes("POST /agenda/horario"));
  const b = apiDe({ paciente: PAC, marcar: "ocupado" }); r = await executarMarcacao(b.api, rpcDe().rpc, pegar(), ESPS);
  assert.equal(r.estado, "horario_tomado"); assert.ok(b.k.chamadas.includes("DELETE /agenda/reservar"));
});
test("plano inativo: falha de convênio com código claro e a reserva é solta", async () => {
  const { api, k } = apiDe({ paciente: PAC, marcar: "plano_inativo" });
  const r = await executarMarcacao(api, rpcDe().rpc, pegar(), ESPS);
  assert.equal(r.estado, "falha"); assert.equal(r.codigo, "plano_inativo"); assert.ok(k.chamadas.includes("DELETE /agenda/reservar"));
});
test("INCERTO: o marcar estourou o tempo mas a marcação existe -> RECONCILIA pelo id_externo e dá sucesso (sem marcar de novo)", async () => {
  const { api, k } = apiDe({ paciente: PAC, marcar: "timeout", vouchers: [{ id: 26701, status: "agendado", data: "2026-11-20", hora: "09:40:00", id_externo: OP, procedimento: { id: 1096, descr: "CONSULTA" } }] });
  const r = await executarMarcacao(api, rpcDe().rpc, pegar(), ESPS);
  assert.equal(r.estado, "sucesso"); assert.equal(r.codigo, "reconciliado"); assert.equal(r.voucher?.id, "26701");
  assert.equal(k.chamadas.filter((c) => c === "POST /agenda/horario").length, 1);
});
test("INCERTO: estourou o tempo e NÃO aparece nas marcações -> incerto (a equipe confere ANTES de marcar de novo); 5xx em HTML também", async () => {
  for (const marcar of ["timeout", "html500"] as const) {
    const { api, k } = apiDe({ paciente: PAC, marcar, vouchers: [] });
    const r = await executarMarcacao(api, rpcDe().rpc, pegar(), ESPS);
    assert.equal(r.estado, "incerto", marcar); assert.equal(k.chamadas.filter((c) => c === "POST /agenda/horario").length, 1, "nunca tenta marcar de novo");
  }
  const sv = apiDe({ paciente: PAC, marcar: "sem_voucher", vouchers: [] });
  assert.equal((await executarMarcacao(sv.api, rpcDe().rpc, pegar(), ESPS)).codigo, "resposta_sem_voucher");
});
test("achar o voucher: pelo id_externo, ou por data+hora quando só há um; vários iguais não adivinha", () => {
  const v = (id: number, ext: string | null, hora = "09:40:00") => ({ id, status: "agendado", data: "2026-11-20", hora, id_externo: ext, procedimento: { id: 1096 } });
  assert.equal(acharVoucher([v(1, null), v(2, OP)], OP, "2026-11-20", "09:40", 1096)?.id, "2");
  assert.equal(acharVoucher([v(3, null)], OP, "2026-11-20", "09:40", 1096)?.id, "3");
  assert.equal(acharVoucher([v(4, null), v(5, null)], OP, "2026-11-20", "09:40", 1096), null);
  assert.equal(acharVoucher([v(6, null, "10:00:00")], OP, "2026-11-20", "09:40", 1096), null);
});
test("convênio sem tradução ou plano diferente do da oferta: não marca", async () => {
  let r = await executarMarcacao(apiDe({ paciente: PAC }).api, rpcDe({ plano: null }).rpc, pegar(), ESPS);
  assert.equal(r.codigo, "sem_traducao");
  const a = apiDe({ paciente: PAC }); r = await executarMarcacao(a.api, rpcDe({ plano: 28 }).rpc, pegar(), ESPS);
  assert.equal(r.codigo, "plano_mudou_depois_da_oferta"); assert.ok(!a.k.chamadas.includes("POST /externo/login"));
});
test("PACIENTE NOVO: cria UM pré-cadastro, guarda o id e entra com o número SEM o P (conferindo id, nome e nascimento)", async () => {
  const { api, k } = apiDe({ paciente: null }); const { rpc, gravados } = rpcDe({ preCadastro: true });
  const r = await executarMarcacao(api, rpc, pegar(), ESPS);
  assert.equal(r.estado, "sucesso");
  assert.equal(k.chamadas.filter((c) => c === "POST /externo/register").length, 1);
  assert.equal(k.corpos.find((c) => c.rota === "POST /externo/login")!.corpo.id, "7960");
  const reg = k.corpos.find((c) => c.rota === "POST /externo/register")!.corpo.paciente;
  assert.equal(reg.docs.cpf, CPF); assert.equal(reg.dt_nasc, NASC); assert.equal(reg.sexo, "F");
  assert.deepEqual(gravados.filter((g) => g.nome === "klingo_pre_gravar").map((g) => g.args.p_klingo_id), ["7960"]);
});
test("PACIENTE NOVO que já tem pré-cadastro nosso: reaproveita o id (NÃO registra de novo)", async () => {
  const { api, k } = apiDe({ paciente: null }); const { rpc } = rpcDe({ preCadastro: true, pre: { acao: "existente", klingo_id: "7900" } });
  const r = await executarMarcacao(api, rpc, pegar(), ESPS);
  assert.equal(r.estado, "sucesso"); assert.ok(!k.chamadas.includes("POST /externo/register")); assert.equal(k.corpos.find((c) => c.rota === "POST /externo/login")!.corpo.id, "7900");
});
test("PACIENTE NOVO: sem liberação não registra; registro que estourou o tempo é INCERTO (não repete); outro registro em andamento bloqueia", async () => {
  let a = apiDe({ paciente: null }); let r = await executarMarcacao(a.api, rpcDe({ preCadastro: false }).rpc, pegar(), ESPS);
  assert.equal(r.codigo, "paciente_novo_nao_liberado"); assert.ok(!a.k.chamadas.includes("POST /externo/register"));
  a = apiDe({ paciente: null, register: "timeout" }); r = await executarMarcacao(a.api, rpcDe({ preCadastro: true }).rpc, pegar(), ESPS);
  assert.equal(r.estado, "incerto"); assert.equal(r.codigo, "registro_incerto"); assert.equal(a.k.chamadas.filter((c) => c === "POST /externo/register").length, 1);
  a = apiDe({ paciente: null }); r = await executarMarcacao(a.api, rpcDe({ preCadastro: true, pre: { acao: "bloqueado" } }).rpc, pegar(), ESPS);
  assert.equal(r.estado, "incerto"); assert.ok(!a.k.chamadas.includes("POST /externo/register"));
});
test("paciente com id sem o P (formato errado) nunca é logado", async () => {
  const a = apiDe({ paciente: { ...PAC, id: "123" } }); const r = await executarMarcacao(a.api, rpcDe().rpc, pegar(), ESPS);
  assert.equal(r.codigo, "sem_id_definitivo"); assert.ok(!a.k.chamadas.includes("POST /externo/login"));
});
test("erro inesperado DEPOIS de tentar marcar vira INCERTO; antes disso vira falha comum", async () => {
  const k = klingo({ paciente: PAC });
  const api = new KlingoApi("t", async (u, i) => { if (String(u).includes("/vouchers")) throw new Error("rede"); return k.f(u, i); }, semEspera);
  const k2 = klingo({ paciente: PAC, marcar: "timeout" });
  const api2 = new KlingoApi("t", async (u, i) => { if (String(u).includes("/vouchers")) throw new Error("rede"); return k2.f(u, i); }, semEspera);
  assert.equal((await executarMarcacao(api2, rpcDe().rpc, pegar(), ESPS)).estado, "incerto");   // não deu nem para conferir
  const semDados = pegar({ cpf: null });
  assert.equal((await executarMarcacao(api, rpcDe().rpc, semDados, ESPS)).codigo, "dados_incompletos");
});

// ------------------------------------------------------------------ ofertas do chat
test("o que perguntar à API: consulta pela especialidade, exame pelo id, vários exames ou especialidade sem API = não", () => {
  const base = { tipo: "consulta", plano: "Particular", procedimento: 1096, n_procedimentos: 1, cpf: CPF, nascimento: NASC, sexo: "F", identidade: null };
  assert.deepEqual(pedidoDaApi(base, ESPS), { especialidade: "225112" });
  assert.deepEqual(pedidoDaApi({ ...base, procedimento: 1472 }, ESPS), { especialidade: "225112" });
  assert.equal(pedidoDaApi({ ...base, procedimento: 9999 }, ESPS), null);
  assert.deepEqual(pedidoDaApi({ ...base, tipo: "exame", procedimento: 1725 }, ESPS), { exame: "1725" });
  assert.equal(pedidoDaApi({ ...base, n_procedimentos: 2 }, ESPS), null);
});
test("montar as ofertas: chave, médico, unidade e o procedimento de CADA horário; sem duplicar e sem horário torto", () => {
  const h = (id: string, hora: string, proc: string) => ({ id, data: "2026-11-20", hora, procedimento: proc, ordem_chegada: false, faixa_ordem_chegada: null,
    profissional: { id: "63", nome: "GEANNE", conselho: null, numero: null, uf: null, subespecialidade: null }, unidade: { id: "2", nome: "DESENVOAR", sigla: "PEDIATRIA", cnes: null } });
  const o = montarOfertas([h("a", "09:40", "1096"), h("a", "09:40", "1096"), h("b", "9h", "1096"), h("c", "10:00", "1472")]);
  assert.deepEqual(o.map((x) => [x.chave, x.procedimento, x.unidade]), [["a", 1096, "DESENVOAR"], ["c", 1472, "DESENVOAR"]]);
});

// ------------------------------------------------------------------ etapa 4: cancelar e remarcar
const opDe = (tipo: string, detalhe: Record<string, unknown>): Pegar => ({ ...pegar(), operacao: { id: OP, tipo, conversa_id: "22222222-2222-4222-8222-222222222222", detalhe } });
const V26700 = { id: 26700, status: "agendado", data: "2026-11-20", hora: "09:40:00", id_externo: "antigo" };

test("CANCELAR: sessão conferida, o voucher está entre as marcações ativas -> DELETE /voucher -> sucesso", async () => {
  const { api, k } = apiDe({ paciente: PAC, vouchers: [V26700], vouchersDepoisDeCancelar: [] });
  const r = await executar(api, rpcDe().rpc, opDe("cancelar", { voucher: "26700" }), ESPS);
  assert.equal(r.estado, "sucesso"); assert.equal(r.voucher?.id, "26700");
  assert.deepEqual(k.chamadas, ["GET /paciente/cpf", "POST /externo/login", "GET /vouchers", "DELETE /voucher"]);
  assert.equal(k.corpos.find((c) => c.rota === "DELETE /voucher")!.corpo.id, "26700");
});
test("CANCELAR: voucher que não está ativo (já cancelado) é sucesso sem chamar DELETE; DELETE 'já cancelado' também", async () => {
  let a = apiDe({ paciente: PAC, vouchers: [] });
  let r = await executar(a.api, rpcDe().rpc, opDe("cancelar", { voucher: "26700" }), ESPS);
  assert.equal(r.estado, "sucesso"); assert.equal(r.codigo, "ja_cancelado"); assert.ok(!a.k.chamadas.includes("DELETE /voucher"));
  a = apiDe({ paciente: PAC, vouchers: [V26700], cancelar: "ja_cancelado" });
  r = await executar(a.api, rpcDe().rpc, opDe("cancelar", { voucher: "26700" }), ESPS);
  assert.equal(r.estado, "sucesso"); assert.equal(r.codigo, "ja_cancelado");
});
test("CANCELAR com o tempo esgotado: confere a lista — sumiu = sucesso; continua lá = INCERTO (equipe)", async () => {
  let a = apiDe({ paciente: PAC, vouchers: [V26700], vouchersDepoisDeCancelar: [], cancelar: "timeout" });
  let r = await executar(a.api, rpcDe().rpc, opDe("cancelar", { voucher: "26700" }), ESPS);
  assert.equal(r.estado, "sucesso"); assert.equal(r.codigo, "reconciliado");
  a = apiDe({ paciente: PAC, vouchers: [V26700], vouchersDepoisDeCancelar: [V26700], cancelar: "timeout" });
  r = await executar(a.api, rpcDe().rpc, opDe("cancelar", { voucher: "26700" }), ESPS);
  assert.equal(r.estado, "incerto"); assert.equal(a.k.chamadas.filter((c) => c === "DELETE /voucher").length, 1, "não repete o cancelamento");
});
test("CANCELAR: nascimento diferente, cadastro inexistente ou voucher com formato estranho não cancelam nada", async () => {
  let a = apiDe({ paciente: { ...PAC, dt_nasc: "1999-01-01" }, vouchers: [V26700] });
  assert.equal((await executar(a.api, rpcDe().rpc, opDe("cancelar", { voucher: "26700" }), ESPS)).codigo, "nascimento_divergente");
  assert.ok(!a.k.chamadas.some((c) => c.includes("login") || c.includes("DELETE")));
  a = apiDe({ paciente: null, vouchers: [V26700] });
  assert.equal((await executar(a.api, rpcDe({ preCadastro: true }).rpc, opDe("cancelar", { voucher: "26700" }), ESPS)).codigo, "cadastro_nao_encontrado");
  assert.ok(!a.k.chamadas.includes("POST /externo/register") && !a.k.chamadas.includes("DELETE /voucher"));
  a = apiDe({ paciente: PAC, vouchers: [V26700] });
  assert.equal((await executar(a.api, rpcDe().rpc, opDe("cancelar", { voucher: "26700; drop" }), ESPS)).codigo, "dados_incompletos");
  assert.equal(a.k.chamadas.length, 0);
});
test("REMARCAR: confere que o voucher antigo é desta sessão, reserva sem 'remarcacao', marca COM 'remarcacao' (o Klingo cancela o antigo sozinho)", async () => {
  const { api, k } = apiDe({ paciente: PAC, vouchers: [V26700] });
  const r = await executar(api, rpcDe().rpc, opDe("remarcar", { chave: CHAVE, remarcacao: "26700" }), ESPS);
  assert.equal(r.estado, "sucesso"); assert.equal(r.voucher?.id, "26700".replace("26700", "26700"));
  assert.deepEqual(k.chamadas, ["GET /paciente/cpf", "POST /externo/login", "GET /vouchers", "GET /agenda/horarios", "POST /agenda/reservar", "POST /agenda/horario"]);
  assert.equal(k.corpos.find((c) => c.rota === "POST /agenda/reservar")!.corpo.remarcacao, undefined);
  assert.equal(k.corpos.find((c) => c.rota === "POST /agenda/horario")!.corpo.remarcacao, 26700);
});
test("REMARCAR: voucher antigo que não é desta sessão não reserva nem marca; paciente sem cadastro não remarca", async () => {
  let a = apiDe({ paciente: PAC, vouchers: [{ ...V26700, id: 1 }] });
  assert.equal((await executar(a.api, rpcDe().rpc, opDe("remarcar", { chave: CHAVE, remarcacao: "26700" }), ESPS)).codigo, "voucher_antigo_nao_encontrado");
  assert.ok(!a.k.chamadas.some((c) => c.includes("reservar") || c.endsWith("/agenda/horario")));
  a = apiDe({ paciente: null });
  assert.equal((await executar(a.api, rpcDe({ preCadastro: true }).rpc, opDe("remarcar", { chave: CHAVE, remarcacao: "26700" }), ESPS)).codigo, "cadastro_nao_encontrado");
  a = apiDe({ paciente: PAC, vouchers: [V26700], marcar: "timeout" });
  const r = await executar(a.api, rpcDe().rpc, opDe("remarcar", { chave: CHAVE, remarcacao: "26700" }), ESPS);
  assert.equal(r.estado, "incerto", "remarcação com tempo esgotado e sem o voucher novo na lista é INCERTA");
});
test("tipo de operação desconhecido não faz nada", async () => {
  const a = apiDe({ paciente: PAC });
  assert.equal((await executar(a.api, rpcDe().rpc, opDe("ler_vouchers", {}), ESPS)).codigo, "tipo_nao_suportado");
  assert.equal(a.k.chamadas.length, 0);
});
