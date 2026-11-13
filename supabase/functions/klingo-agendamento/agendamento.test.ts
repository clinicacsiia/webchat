// Testes da página de agendamento com um KLINGO DE MENTIRA e um banco em memória (dados inventados, nenhuma chamada de rede).
// Rodar: cd testes && npm run test:edge
import { test } from "node:test";
import assert from "node:assert/strict";
import { cotaGlobal, cpfValido, KlingoApi, limparCatalogo, resumoCadastro } from "./api.ts";
import { type Banco, type Ctx, tratar } from "./regras.ts";

const CPF = "11144477735", NASC = "1980-03-25", CHAVE = "2026-11-20|63|308|2|09:40";
const resp = (status: number, corpo: unknown, tipo = "application/json") => new Response(typeof corpo === "string" ? corpo : JSON.stringify(corpo), { status, headers: { "content-type": tipo } });
const timeout = () => { const e = new Error("t"); e.name = "TimeoutError"; return e; };

type Cena = {
  paciente?: Record<string, unknown> | null; loginUser?: Record<string, unknown>; vouchers?: Array<Record<string, unknown>>;
  marcar?: "ok" | "ocupado" | "timeout" | "timeout_mas_criou"; reservar?: "ok" | "ocupado"; cancelar?: "ok" | "ja_cancelado";
  register?: "ok" | "timeout"; horarios?: "ok" | "sem_medico" | "plano_inativo"; resultado?: "html403" | "pronto" | "pendente"; recuperar?: "ok" | "erro";
};
function klingo(c: Cena = {}) {
  const chamadas: string[] = []; const urls: string[] = []; const corpos: Array<{ rota: string; corpo: any }> = []; let criouComIdExterno: string | null = null;
  const f = async (url: string, init?: RequestInit) => {
    const u = new URL(url); const rota = `${init?.method ?? "GET"} ${u.pathname.replace("/api", "")}`; chamadas.push(rota); urls.push(String(url));
    const corpo = init?.body ? JSON.parse(String(init.body)) : undefined; corpos.push({ rota, corpo });
    if (rota === "GET /live") return resp(200, "OK [API1]");
    if (rota === "GET /paciente/cpf") return c.paciente ? resp(200, c.paciente) : resp(403, { msg: "Paciente não identificado", code: "PACIENTE_NAO_IDENTIFICADO" });
    if (rota === "POST /externo/login") return resp(200, { access_token: "tok", user: c.loginUser ?? { id: corpo.id, nome: "Maria Teste", nascimento: NASC, id_paciente: /^P/.test(corpo.id) ? corpo.id : "", plano: { id: 1, nome: "PARTICULAR" } } });
    if (rota === "POST /externo/register") { if (c.register === "timeout") throw timeout(); return resp(200, { id: 7960 }); }
    if (rota === "GET /agenda/horarios") {
      if (c.horarios === "sem_medico") return resp(403, { msg: "Nenhum médico credenciado para CONSULTA (68), para operadora X." });
      if (c.horarios === "plano_inativo") return resp(403, { msg: "Plano X inativo.", status_code: 403 });
      return resp(200, { horarios: [{ id: "x", data: "2026-11-20", procedimento: 1096, profissional: { id: 63, nome: "DRA TESTE" }, unidade: { id: 2, nome: "DESENVOAR", sigla: "PEDIATRIA" }, horarios: { [CHAVE]: "09:40" } }] });
    }
    if (rota === "POST /agenda/reservar") return c.reservar === "ocupado" ? resp(403, { msg: "Horário já ocupado. [reservado]" }) : resp(200, { id: 555, expira: "2026-11-20 09:50:00" });
    if (rota === "DELETE /agenda/reservar") return resp(200, { status: "ok" });
    if (rota === "POST /agenda/horario") {
      if (c.marcar === "ocupado") return resp(400, { msg: "Horário já ocupado. …ID: 6901" });
      if (c.marcar === "timeout") throw timeout();
      if (c.marcar === "timeout_mas_criou") { criouComIdExterno = corpo.id_externo; throw timeout(); }
      return resp(200, { id: 26700, status: "agendado", data: "2026-11-20", hora: "09:40:00", procedimento: { id: 1096, descr: "CONSULTA" }, unidade: { nome: "DESENVOAR" }, realizador: { nome: "DRA TESTE" } });
    }
    if (rota === "GET /vouchers") return resp(200, [...(c.vouchers ?? []), ...(criouComIdExterno ? [{ id: 26701, status: "agendado", data: "2026-11-20", hora: "09:40", id_externo: criouComIdExterno }] : [])]);
    if (rota === "DELETE /voucher") return c.cancelar === "ja_cancelado" ? resp(403, { msg: "Agendamento já cancelado." }) : resp(200, "ok");
    if (rota === "PUT /agenda/procedimento") return resp(200, { id: 26638, status: "agendado", procedimento: { id: 1472, descr: "NEUROPEDIATRIA" } });
    if (rota === "POST /checkin") return resp(200, { checkinrealizado: { id: ["1"], id_marcacao: 26638, local: "Recepção 1", recepcao: "R1", preferencial: false, expresso: "N" } });
    if (rota === "DELETE /checkin") return resp(200, "ok");
    if (rota === "PUT /paciente") return resp(200, {});
    if (rota === "GET /paciente") return resp(200, { id: "P123", nome: "Maria Teste", sexo: "F", dt_nasc: NASC, mae: "Mãe Teste", docs: { cpf: CPF, rg: "123" }, contatos: { celular: "71999998888", email: "maria@exemplo.com" }, endereco: { endereco: "Rua X" }, convenio: { nome: "PLANSERV", id_plano: 28 } });
    if (rota.startsWith("GET /resultado/") && !rota.includes("/an/")) return c.resultado === "html403" ? resp(403, "<html>proibido</html>", "text/html") : resp(200, { pronto: c.resultado === "pronto", status: "ok", pdf: "QUJD" });
    if (rota === "POST /paciente/identificar") return corpo.dt_nascimento === NASC ? resp(200, { access_token: "tokT", user: { id: "P123", nome: "Maria Teste", nascimento: NASC } }) : resp(403, { msg: "credenciais inválidas" });
    if (rota === "POST /externo/portal/login") return corpo.senha === "senha123" ? resp(200, { access_token: "tokP", user: { id: "7961", nome: "Joana Teste", nascimento: NASC, id_paciente: "" } }) : resp(403, { msg: "dados inválidos" });
    if (rota === "POST /externo/portal/register") return resp(200, { id: 7961 });
    if (rota === "POST /externo/portal/recuperar") return c.recuperar === "erro" ? resp(403, { msg: "email não existe" }) : resp(200, { level: "success", msg: "enviado" });
    if (rota === "GET /agenda/verificar_horario") return resp(200, { operadoras: [{ id: 1, nome: "PARTICULAR", cpf: "11144477735" }], procedimentos: [{ id: 1096, descr: "CONSULTA" }] });
    if (rota === "GET /resultado/pdf/an/AN1") return resp(200, { id_marcacao: "1", id_atendimento: "2", pdf_base64: "QUJD" });
    if (rota.startsWith("GET /resultado/pdf/an/")) return resp(403, "<html>nada</html>", "text/html");
    if (rota === "GET /atendimentos") return resp(200, [
      { id: "1", paciente: { nome: "Fulano Sigiloso", docs: { cpf: "99999999999" }, mae: "Mãe Sigilo", contatos: { celular: "71988887777" } }, medico: { nome: "DRA TESTE" }, plano: { nome: "PARTICULAR" }, procedimento: [{ descr: "CONSULTA" }] },
      { id: "2", paciente: { nome: "Beltrano Sigiloso" }, medico: { nome: "DRA TESTE" }, plano: { nome: "PLANSERV" }, procedimento: [{ descr: "CONSULTA" }, { descr: "ECG" }] }]);
    if (rota === "GET /telefonia/live") return resp(200, "OK");
    if (rota.startsWith("GET /telefonia/lista/")) return resp(200, [{ id_marcacao: "9", nome: "Fulano Sigiloso", cpf: "99999999999", celular: "71988887777", id_paciente: "5", data: "2026-11-13", hora: "09:00", procedimento: "CONSULTA", medico: "DRA TESTE", unidade: "CSI", status: "A" }]);
    if (rota === "GET /telefonia/bloqueios") return resp(200, [{ id: 1, medico: "DRA TESTE", de: "2026-11-20", ate: "2026-11-21" }]);
    if (rota === "POST /telefonia/confirmar" || rota === "POST /telefonia/nps") return resp(200, "OK");
    if (rota === "GET /unidades") return resp(200, [{ id: 1, nome: "CSI", medico: { nome: "X", cpf: "11144477735", foto: "base64..." } }]);
    return resp(404, "nao");
  };
  return { f, chamadas, urls, corpos };
}

function banco(inicial: { divergentes?: number; pre?: Array<{ chave: string; cpf: string; klingo_id: string | null }>; precadastros?: number } = {}) {
  const pre = [...(inicial.pre ?? [])]; const tentativas: string[] = []; const regs: any[] = []; const gravados: string[] = []; let soltou = 0; let divergentes = inicial.divergentes ?? 0;
  const db: Banco = {
    hash: async (t) => "h:" + t,
    divergentesRecentes: async () => divergentes,
    registrarIdentidade: async (cpf, nasc, r) => { regs.push({ cpf, nasc, r }); if (r.situacao === "divergente") divergentes++; },
    preDoPar: async (cpf, nasc) => { const p = pre.find((x) => x.chave === `h:${cpf}|${nasc}`); return p ? { klingo_id: p.klingo_id } : null; },
    reservarPre: async (cpf, nasc) => {
      const ex = pre.find((x) => x.cpf === cpf);
      if (ex) return { criado: false, mesmoPar: ex.chave === `h:${cpf}|${nasc}`, klingo_id: ex.klingo_id, idadeMin: 1 };
      pre.push({ chave: `h:${cpf}|${nasc}`, cpf, klingo_id: null }); return { criado: true, mesmoPar: true, klingo_id: null, idadeMin: 0 };
    },
    gravarPre: async (cpf, nasc, id) => { gravados.push(id); const p = pre.find((x) => x.cpf === cpf); if (p) p.klingo_id = id; },
    soltarPre: async (cpf) => { soltou++; const i = pre.findIndex((x) => x.cpf === cpf && x.klingo_id === null); if (i >= 0) pre.splice(i, 1); },
    precadastrosRecentes: async () => inicial.precadastros ?? 0,
    registrarTentativa: async (chave) => { tentativas.push(chave); divergentes++; },
  };
  return { db, regs, tentativas, gravados, pre, get soltou() { return soltou; } };
}

function montar(c: Cena = {}, b = banco(), extra: Partial<Ctx> = {}) {
  const k = klingo(c); let n = 0;
  const api = new KlingoApi("clinicacsi:xxxx", k.f);
  const ctx: Ctx = { api, db: b.db, hoje: () => "2026-11-13", agora: () => Date.now(), uuid: () => `u${++n}`, cache: new Map(), resultado: true, ...extra };
  return { ctx, k, b };
}
const paciente = (extra: Record<string, unknown> = {}) => ({ id: "P123", nome: "Maria Teste", dt_nasc: NASC, ...extra });
const ident = { cpf: CPF, nascimento: NASC };

// ----------------------------------------------------------------------------------------------------------------------- sem identidade
test("horários: lista enxuta, período padrão e janela máxima", async () => {
  const { ctx, k } = montar();
  const r = await tratar(ctx, { acao: "horarios", especialidade: "225112", inicio: "2026-11-20", fim: "2026-11-25" });
  assert.equal(r.status, 200); assert.equal(r.corpo.total, 1);
  assert.equal((r.corpo.horarios as any[])[0].id, CHAVE); assert.equal((r.corpo.horarios as any[])[0].hora, "09:40");
  const q = k.corpos.length; await tratar(ctx, { acao: "horarios", especialidade: "225112", inicio: "2026-11-20", fim: "2026-11-25" });
  assert.equal(k.corpos.length, q, "a segunda consulta igual vem do cache (não gasta a cota do Klingo)");
  assert.equal((await tratar(montar().ctx, { acao: "horarios", especialidade: "225112", inicio: "2026-11-01", fim: "2026-12-30" })).status, 400);
  assert.equal((await tratar(montar().ctx, { acao: "horarios" })).status, 400);
  assert.equal((await tratar(montar().ctx, { acao: "horarios", exame: "abc" })).status, 400);
});
test("horários: convênio sem médico ou plano inativo não é falha, é lista vazia com o motivo", async () => {
  for (const [cena, motivo] of [["sem_medico", "sem_medico"], ["plano_inativo", "plano_inativo"]] as const) {
    const r = await tratar(montar({ horarios: cena }).ctx, { acao: "horarios", especialidade: "225112", plano: "17" });
    assert.equal(r.status, 200); assert.equal(r.corpo.ok, true); assert.equal(r.corpo.total, 0); assert.equal(r.corpo.motivo, motivo);
  }
});
test("catálogo: tira CPF e foto, exige parâmetros e recusa catálogo desconhecido", async () => {
  const { ctx } = montar();
  const r = await tratar(ctx, { acao: "catalogo", catalogo: "unidades" });
  const txt = JSON.stringify(r.corpo); assert.ok(!txt.includes("11144477735") && !txt.includes("base64") && !txt.includes("foto"), "nada pessoal");
  assert.equal((await tratar(ctx, { acao: "catalogo", catalogo: "preco", id_procedimento: "1096" })).status, 400);   // falta id_plano
  assert.equal((await tratar(ctx, { acao: "catalogo", catalogo: "../x" })).status, 400);
  assert.equal((await tratar(ctx, { acao: "catalogo", catalogo: "profissional", id_medico: "1; drop" })).status, 400);
});
test("dinheiro e rotas perigosas NÃO existem", async () => {
  const { ctx, k } = montar();
  for (const a of ["adiantamento", "pagamento", "registrar_atendimento", "formas_de_pagamento", "atendimentos", "identificar_telefone", "pagamentos"]) {
    const r = await tratar(ctx, { acao: a, ...ident, confirmar: true }); assert.equal(r.status, 400, a); assert.equal(r.corpo.motivo, "acao_invalida");
  }
  assert.equal(k.chamadas.length, 0, "nenhuma chamada ao Klingo");
});
test("CPF: dígitos verificadores", () => { assert.equal(cpfValido("111.444.777-35"), CPF); assert.equal(cpfValido("11144477736"), null); assert.equal(cpfValido("11111111111"), null); });
test("cota global da página pública desiste depressa (não segura as rotinas internas)", async () => {
  const esperas: number[] = []; let chamadas = 0;
  const cota = cotaGlobal(async () => { chamadas++; return { data: { ok: false, espera_ms: 99999 } }; }, { esperar: async (ms) => { esperas.push(ms); } });
  await assert.rejects(cota(), /limite/); assert.equal(chamadas, 4); assert.ok(esperas.every((e) => e <= 2000));
});

// ----------------------------------------------------------------------------------------------------------------------- identidade
test("identificar: confere, abre a sessão com o id exato e registra", async () => {
  const { ctx, k, b } = montar({ paciente: paciente() });
  const r = await tratar(ctx, { acao: "identificar", ...ident });
  assert.equal(r.corpo.ok, true); assert.equal(r.corpo.primeiro_nome, "Maria"); assert.equal(r.corpo.tipo, "definitivo");
  assert.deepEqual(k.corpos.find((x) => x.rota === "POST /externo/login")!.corpo, { id: "P123" });
  assert.equal(b.regs[0].r.situacao, "confere");
});
test("identificar: nascimento errado não confere e conta para a trava; a resposta não revela se o CPF existe", async () => {
  const errado = montar({ paciente: paciente() }); const r1 = await tratar(errado.ctx, { acao: "identificar", cpf: CPF, nascimento: "1999-01-01" });
  const inexistente = montar({ paciente: null }); const r2 = await tratar(inexistente.ctx, { acao: "identificar", ...ident });
  assert.deepEqual(r1.corpo, r2.corpo); assert.equal(r1.corpo.motivo, "nao_confere");
  assert.equal(errado.b.regs[0].r.situacao, "divergente"); assert.ok(!errado.k.chamadas.includes("POST /externo/login"), "sem login");
});
test("trava: 5 nascimentos errados para o mesmo CPF fecham o CPF sem chamar o Klingo", async () => {
  const { ctx, k } = montar({ paciente: paciente() }, banco({ divergentes: 5 }));
  const r = await tratar(ctx, { acao: "identificar", ...ident });
  assert.equal(r.status, 429); assert.equal(r.corpo.motivo, "tentativas_demais"); assert.equal(k.chamadas.length, 0);
});
test("sessão de outra pessoa é recusada (id ou nascimento diferentes)", async () => {
  for (const loginUser of [{ id: "P999", nascimento: NASC, nome: "Outra" }, { id: "P123", nascimento: "1970-01-01", nome: "Outra" }]) {
    const r = await tratar(montar({ paciente: paciente(), loginUser }).ctx, { acao: "minhas_marcacoes", ...ident });
    assert.equal(r.corpo.motivo, "sessao_nao_confere");
  }
});
test("só id definitivo 'P…' é aceito vindo do Klingo", async () => {
  const r = await tratar(montar({ paciente: paciente({ id: "123" }) }).ctx, { acao: "identificar", ...ident });
  assert.equal(r.corpo.motivo, "sem_cadastro_definitivo");
});
test("pré-cadastro: entra com o número SEM o P e a sessão tem que ser dele", async () => {
  const b = banco({ pre: [{ chave: `h:${CPF}|${NASC}`, cpf: CPF, klingo_id: "7960" }] });
  const { ctx, k } = montar({ paciente: null }, b);
  const r = await tratar(ctx, { acao: "identificar", ...ident });
  assert.equal(r.corpo.ok, true); assert.equal(r.corpo.pre_cadastro, true);
  assert.deepEqual(k.corpos.find((x) => x.rota === "POST /externo/login")!.corpo, { id: "7960" });
  const virou = montar({ paciente: null, loginUser: { id: "7960", nascimento: NASC, id_paciente: "P55" } }, banco({ pre: [{ chave: `h:${CPF}|${NASC}`, cpf: CPF, klingo_id: "7960" }] }));
  assert.equal((await tratar(virou.ctx, { acao: "identificar", ...ident })).corpo.motivo, "sessao_nao_confere");
  const marcaSemId = montar({ paciente: null }, banco({ pre: [{ chave: `h:${CPF}|${NASC}`, cpf: CPF, klingo_id: null }] }));
  assert.equal((await tratar(marcaSemId.ctx, { acao: "identificar", ...ident })).corpo.motivo, "nao_confere", "marca sem id (registro incerto) não abre sessão");
});
test("meus dados: contatos mascarados, sem CPF, RG, mãe nem endereço", async () => {
  const r = await tratar(montar({ paciente: paciente() }).ctx, { acao: "meus_dados", ...ident });
  const txt = JSON.stringify(r.corpo);
  assert.ok(!txt.includes(CPF), "sem CPF");
  for (const proibido of ["71999998888", "maria@exemplo.com", "Mãe Teste", "Rua X", '"rg"']) assert.ok(!txt.includes(proibido), proibido);
  assert.match(String((r.corpo.dados as any).celular), /8888$/); assert.match(String((r.corpo.dados as any).email), /^m•••@exemplo\.com$/);
  assert.equal(resumoCadastro({}).nome, null);
});
test("atualizar contato: valida o formato e só manda os contatos", async () => {
  const { ctx, k } = montar({ paciente: paciente() });
  assert.equal((await tratar(ctx, { acao: "atualizar_contato", ...ident, celular: "123" , confirmar: true })).status, 400);
  assert.equal((await tratar(ctx, { acao: "atualizar_contato", ...ident, celular: "71999990000" })).corpo.motivo, "sem_confirmacao");
  const r = await tratar(ctx, { acao: "atualizar_contato", ...ident, celular: "(71) 99999-0000", email: "a@b.com", confirmar: true });
  assert.equal(r.corpo.ok, true);
  assert.deepEqual(k.corpos.find((x) => x.rota === "PUT /paciente")!.corpo, { paciente: { contatos: { celular: "71999990000", email: "a@b.com" } } });
});

// ----------------------------------------------------------------------------------------------------------------------- marcar e o resto
const base = { ...ident, horario: CHAVE, procedimento: "1096", plano: "1", confirmar: true };
test("marcar: exige confirmação, reserva e marca, e devolve o voucher enxuto", async () => {
  const { ctx, k } = montar({ paciente: paciente() });
  assert.equal((await tratar(ctx, { ...base, acao: "marcar", confirmar: false })).corpo.motivo, "sem_confirmacao");
  const r = await tratar(ctx, { ...base, acao: "marcar" });
  assert.equal(r.corpo.ok, true); assert.equal((r.corpo.voucher as any).id, "26700"); assert.equal((r.corpo.voucher as any).hora, "09:40");
  const ordem = k.chamadas.filter((x) => /reservar|horario$/.test(x)); assert.deepEqual(ordem, ["POST /agenda/reservar", "POST /agenda/horario"]);
  const corpo = k.corpos.find((x) => x.rota === "POST /agenda/horario")!.corpo;
  assert.equal(corpo.id, CHAVE); assert.equal(corpo.plano, 1); assert.equal(corpo.email, false); assert.match(corpo.id_externo, /^pagina-u\d+$/);
});
test("marcar: dados inválidos nunca chegam ao Klingo", async () => {
  const { ctx, k } = montar({ paciente: paciente() });
  for (const ruim of [{ horario: "x|y" }, { procedimento: "1096; x" }, { plano: "um" }, { obs: "a\nb" }]) assert.equal((await tratar(ctx, { ...base, acao: "marcar", ...ruim })).status, 400);
  assert.ok(!k.chamadas.includes("POST /agenda/horario"));
});
test("marcar: horário tomado na reserva ou na marcação devolve 'horario_ocupado' e solta a reserva", async () => {
  const a = montar({ paciente: paciente(), reservar: "ocupado" }); assert.equal((await tratar(a.ctx, { ...base, acao: "marcar" })).corpo.motivo, "horario_ocupado");
  const b = montar({ paciente: paciente(), marcar: "ocupado" }); assert.equal((await tratar(b.ctx, { ...base, acao: "marcar" })).corpo.motivo, "horario_ocupado");
  assert.ok(b.k.chamadas.includes("DELETE /agenda/reservar"), "reserva solta");
});
test("marcar: resposta perdida — se o voucher aparece nas marcações ativas é sucesso; se não, INCERTO (não tenta de novo)", async () => {
  const achou = await tratar(montar({ paciente: paciente(), marcar: "timeout_mas_criou" }).ctx, { ...base, acao: "marcar" });
  assert.equal(achou.corpo.ok, true); assert.equal(achou.corpo.reconciliado, true); assert.equal((achou.corpo.voucher as any).id, "26701");
  const m = montar({ paciente: paciente(), marcar: "timeout" }); const incerto = await tratar(m.ctx, { ...base, acao: "marcar" });
  assert.equal(incerto.corpo.motivo, "incerto"); assert.equal(m.k.chamadas.filter((x) => x === "POST /agenda/horario").length, 1);
});
test("reservar e soltar", async () => {
  const { ctx, k } = montar({ paciente: paciente() });
  const r = await tratar(ctx, { ...base, acao: "reservar" }); assert.equal((r.corpo.reserva as any).id, "555");
  assert.equal((await tratar(ctx, { ...ident, acao: "soltar", reserva: "555" })).corpo.ok, true);
  assert.deepEqual(k.corpos.find((x) => x.rota === "DELETE /agenda/reservar")!.corpo, { id: 555 });
  const comReserva = await tratar(ctx, { ...base, acao: "marcar", reserva: "555" });
  assert.equal(comReserva.corpo.ok, true); assert.equal(k.chamadas.filter((x) => x === "POST /agenda/reservar").length, 1, "marcar com reserva não reserva de novo");
});
test("cancelar, trocar procedimento, check-in e resultado só valem para marcação ATIVA do próprio paciente", async () => {
  const { ctx, k } = montar({ paciente: paciente(), vouchers: [{ id: 26638, status: "agendado" }] });
  for (const a of ["cancelar", "trocar_procedimento", "checkin", "cancelar_checkin", "resultado"]) {
    const r = await tratar(ctx, { ...ident, acao: a, voucher: "99999", procedimento: "1472", confirmar: true });
    assert.equal(r.corpo.motivo, "voucher_nao_encontrado", a);
  }
  assert.ok(!k.chamadas.some((x) => /^(DELETE \/voucher|PUT \/agenda\/procedimento|POST \/checkin|DELETE \/checkin|GET \/resultado)/.test(x)), "nada foi enviado ao Klingo");
  assert.equal((await tratar(ctx, { ...ident, acao: "cancelar", voucher: "26638" })).corpo.motivo, "sem_confirmacao");
  assert.equal((await tratar(ctx, { ...ident, acao: "cancelar", voucher: "26638", confirmar: true })).corpo.cancelado, "26638");
  assert.deepEqual(k.corpos.find((x) => x.rota === "DELETE /voucher")!.corpo, { id: "26638" });
  assert.equal((await tratar(ctx, { ...ident, acao: "trocar_procedimento", voucher: "26638", procedimento: "1472", confirmar: true })).corpo.ok, true);
  assert.deepEqual(k.corpos.find((x) => x.rota === "PUT /agenda/procedimento")!.corpo, { id_marcacao: 26638, id_procedimento: 1472 });
  const ck = await tratar(ctx, { ...ident, acao: "checkin", voucher: "26638", confirmar: true, expresso: true });
  assert.equal((ck.corpo.checkin as any).local, "Recepção 1"); assert.deepEqual(k.corpos.find((x) => x.rota === "POST /checkin")!.corpo, { id: 26638, expresso: true, preferencial: false });
});
test("cancelar o que já estava cancelado é sucesso", async () => {
  const r = await tratar(montar({ paciente: paciente(), vouchers: [{ id: 26638 }], cancelar: "ja_cancelado" }).ctx, { ...ident, acao: "cancelar", voucher: "26638", confirmar: true });
  assert.equal(r.corpo.ok, true); assert.equal(r.corpo.ja_estava, true);
});
test("remarcar manda o voucher antigo em 'remarcacao'", async () => {
  const { ctx, k } = montar({ paciente: paciente(), vouchers: [{ id: 26638 }] });
  const r = await tratar(ctx, { ...base, acao: "remarcar", voucher: "26638" }); assert.equal(r.corpo.ok, true);
  assert.equal(k.corpos.find((x) => x.rota === "POST /agenda/horario")!.corpo.remarcacao, 26638);
  assert.equal((await tratar(ctx, { ...base, acao: "remarcar", voucher: "1" })).corpo.motivo, "voucher_nao_encontrado");
});
test("resultado: sem laudo (403 em HTML) é 'ainda não tem', e só entrega se o Klingo disser que está pronto", async () => {
  const v = [{ id: 26638, status: "atendido" }];
  assert.deepEqual((await tratar(montar({ paciente: paciente(), vouchers: v, resultado: "html403" }).ctx, { ...ident, acao: "resultado", voucher: "26638" })).corpo, { ok: true, pronto: false, motivo: "sem_resultado" });
  const p = await tratar(montar({ paciente: paciente(), vouchers: v, resultado: "pendente" }).ctx, { ...ident, acao: "resultado", voucher: "26638" });
  assert.equal(p.corpo.pronto, false); assert.equal(p.corpo.resultado, undefined);
  const ok = await tratar(montar({ paciente: paciente(), vouchers: v, resultado: "pronto" }).ctx, { ...ident, acao: "resultado", voucher: "26638" });
  assert.equal(ok.corpo.pronto, true); assert.equal((ok.corpo.resultado as any).pdf, "QUJD");
});

test("resultado vem DESLIGADO por padrão: não abre sessão nem chama o Klingo", async () => {
  const m = montar({ paciente: paciente(), vouchers: [{ id: 26638 }], resultado: "pronto" }); m.ctx.resultado = undefined;
  const r = await tratar(m.ctx, { ...ident, acao: "resultado", voucher: "26638" });
  assert.equal(r.corpo.motivo, "desligado"); assert.equal(m.k.chamadas.length, 0);
});

// ----------------------------------------------------------------------------------------------------------------------- paciente novo
const novo = { acao: "cadastrar", nome: "Joana da Silva", sexo: "F", nascimento: NASC, cpf: CPF, celular: "71999990000", confirmar: true };
test("cadastrar: cria o pré-cadastro uma vez, guarda o id e não registra de novo", async () => {
  const { ctx, k, b } = montar({ paciente: null });
  const r = await tratar(ctx, novo); assert.equal(r.corpo.ok, true); assert.equal(r.corpo.primeiro_nome, "Joana");
  assert.deepEqual(b.gravados, ["7960"]);
  const reg = k.corpos.find((x) => x.rota === "POST /externo/register")!.corpo.paciente;
  assert.equal(reg.docs.cpf, CPF); assert.equal(reg.sexo, "F"); assert.equal(reg.dt_nasc, NASC);
  const de_novo = await tratar(ctx, novo); assert.equal(de_novo.corpo.motivo, "ja_cadastrado");
  assert.equal(k.chamadas.filter((x) => x === "POST /externo/register").length, 1, "A API aceita duplicar: só registramos uma vez");
});
test("cadastrar: CPF que já tem cadastro — com o nascimento certo manda entrar; com outro, resposta genérica e conta para a trava", async () => {
  const certo = await tratar(montar({ paciente: paciente() }).ctx, novo); assert.equal(certo.corpo.motivo, "ja_cadastrado");
  const m = montar({ paciente: paciente({ dt_nasc: "1990-05-05" }) }); const errado = await tratar(m.ctx, novo);
  assert.equal(errado.corpo.motivo, "nao_foi_possivel"); assert.equal(m.b.regs[0].r.situacao, "divergente"); assert.ok(!m.k.chamadas.includes("POST /externo/register"));
});
test("cadastrar: resposta perdida deixa a marca (nunca registra de novo) e manda procurar a recepção", async () => {
  const m = montar({ paciente: null, register: "timeout" });
  const r = await tratar(m.ctx, novo); assert.equal(r.corpo.motivo, "incerto"); assert.equal(m.b.soltou, 0);
  const outra = await tratar(m.ctx, novo); assert.equal(outra.corpo.motivo, "em_andamento");
  assert.equal(m.k.chamadas.filter((x) => x === "POST /externo/register").length, 1);
});
test("cadastrar: validações, confirmação e teto diário", async () => {
  const { ctx, k } = montar({ paciente: null });
  for (const ruim of [{ nome: "Joana" }, { sexo: "X" }, { cpf: "11144477736" }, { nascimento: "2999-01-01" }, { celular: "123" }, { email: "x" }, { nome: "Jo <b>ana</b> Silva" }]) assert.equal((await tratar(ctx, { ...novo, ...ruim })).status, 400, JSON.stringify(ruim));
  assert.equal((await tratar(ctx, { ...novo, confirmar: false })).corpo.motivo, "sem_confirmacao");
  const cheio = montar({ paciente: null }, banco({ precadastros: 40 })); assert.equal((await tratar(cheio.ctx, novo)).corpo.motivo, "limite_diario");
  assert.ok(!k.chamadas.includes("POST /externo/register") && !cheio.k.chamadas.includes("POST /externo/register"));
});
test("limparCatalogo tira só o que é pessoal", () => {
  assert.deepEqual(limparCatalogo([{ id: 1, nome: "A", cpf: "1", foto: "x", contatos: { a: 1 }, especialidades: [{ cbos: "1", email: "e" }] }]), [{ id: 1, nome: "A", especialidades: [{ cbos: "1" }] }]);
});

// ----------------------------------------------------------------------------------------------------------------------- acrescentado em 13/11/2026 (tudo da documentação, menos dinheiro)
test("verificar_horario: valida a chave e manda o id na query (a doc pede corpo num GET)", async () => {
  const { ctx, k } = montar();
  assert.equal((await tratar(ctx, { acao: "verificar_horario", horario: "x" })).status, 400);
  const r = await tratar(ctx, { acao: "verificar_horario", horario: CHAVE });
  assert.equal(r.corpo.ok, true); assert.ok(!JSON.stringify(r.corpo).includes("11144477735"), "CPF do catálogo é tirado");
  assert.ok(k.urls.some((u) => u.includes("/agenda/verificar_horario?id=")));
});
test("telefone: DESLIGADO por padrão; ligado, exige telefone + nascimento e confere o nascimento da sessão", async () => {
  const desl = montar({ paciente: paciente() });
  const r0 = await tratar(desl.ctx, { acao: "minhas_marcacoes", telefone: "71999998888", nascimento: NASC }); assert.equal(r0.corpo.motivo, "desligado"); assert.equal(desl.k.chamadas.length, 0);
  const m = montar({}, banco(), { telefone: true });
  assert.equal((await tratar(m.ctx, { acao: "identificar", telefone: "123", nascimento: NASC })).status, 400);
  const ok = await tratar(m.ctx, { acao: "identificar", telefone: "(71) 99999-8888", nascimento: NASC });
  assert.equal(ok.corpo.ok, true); assert.equal(ok.corpo.via, "telefone"); assert.equal(ok.corpo.primeiro_nome, "Maria");
  const corpo = m.k.corpos.find((x) => x.rota === "POST /paciente/identificar")!.corpo;
  assert.deepEqual(corpo, { telefone: "71999998888", dt_nascimento: NASC }, "nunca manda apenas_telefone");
  const errado = await tratar(m.ctx, { acao: "identificar", telefone: "71999998888", nascimento: "1990-01-01" });
  assert.equal(errado.corpo.motivo, "nao_confere"); assert.deepEqual(m.b.tentativas, ["tel:71999998888"]);
});
test("telefone: cinco recusas travam aquele telefone (e não chamam mais o Klingo)", async () => {
  const m = montar({}, banco(), { telefone: true });
  for (let i = 0; i < 5; i++) await tratar(m.ctx, { acao: "identificar", telefone: "71999998888", nascimento: `1990-01-0${i + 1}` });
  const antes = m.k.chamadas.length;
  const r = await tratar(m.ctx, { acao: "identificar", telefone: "71999998888", nascimento: NASC });
  assert.equal(r.status, 429); assert.equal(r.corpo.motivo, "tentativas_demais"); assert.equal(m.k.chamadas.length, antes);
});
test("telefone: a sessão serve para as ações do paciente (cancelar só marcação dele)", async () => {
  const m = montar({ vouchers: [{ id: 26638, status: "agendado", data: "2026-11-20", hora: "09:40" }] }, banco(), { telefone: true });
  const t = { telefone: "71999998888", nascimento: NASC, confirmar: true };
  assert.equal((await tratar(m.ctx, { acao: "cancelar", ...t, voucher: "26638" })).corpo.cancelado, "26638");
  assert.equal((await tratar(m.ctx, { acao: "cancelar", ...t, voucher: "99999" })).corpo.motivo, "voucher_nao_encontrado");
});
test("portal: DESLIGADO por padrão; ligado, entra com e-mail + senha e uma senha errada conta para a trava", async () => {
  const desl = montar();
  assert.equal((await tratar(desl.ctx, { acao: "identificar", portal_email: "a@b.com", portal_senha: "senha123" })).corpo.motivo, "desligado");
  assert.equal((await tratar(desl.ctx, { acao: "portal_recuperar", email: "a@b.com", confirmar: true })).corpo.motivo, "desligado");
  assert.equal((await tratar(desl.ctx, { ...novo, acao: "portal_cadastrar", email: "a@b.com", senha: "senha123" })).corpo.motivo, "desligado");
  assert.equal(desl.k.chamadas.length, 0);
  const m = montar({}, banco(), { portal: true });
  const ok = await tratar(m.ctx, { acao: "identificar", portal_email: "Joana@Exemplo.com", portal_senha: "senha123" });
  assert.equal(ok.corpo.ok, true); assert.equal(ok.corpo.via, "portal"); assert.equal(ok.corpo.pre_cadastro, true);
  assert.deepEqual(m.k.corpos.find((x) => x.rota === "POST /externo/portal/login")!.corpo, { email: "joana@exemplo.com", senha: "senha123" });
  const ruim = await tratar(m.ctx, { acao: "identificar", portal_email: "joana@exemplo.com", portal_senha: "errada1" });
  assert.equal(ruim.corpo.motivo, "nao_confere"); assert.deepEqual(m.b.tentativas, ["mail:joana@exemplo.com"]);
  assert.ok(!JSON.stringify(m.b.tentativas).includes("errada1"), "a senha nunca é guardada");
  assert.equal((await tratar(m.ctx, { acao: "identificar", portal_email: "x", portal_senha: "senha123" })).status, 400);
});
test("portal: cadastrar usa a rota do portal, exige e-mail e senha, e guarda a marca uma vez por CPF", async () => {
  const m = montar({ paciente: null }, banco(), { portal: true });
  assert.equal((await tratar(m.ctx, { ...novo, acao: "portal_cadastrar", email: "j@e.com", senha: "123" })).status, 400);
  assert.equal((await tratar(m.ctx, { ...novo, acao: "portal_cadastrar", senha: "senha123" })).status, 400);
  const r = await tratar(m.ctx, { ...novo, acao: "portal_cadastrar", email: "J@e.com", senha: "senha123" });
  assert.equal(r.corpo.ok, true); assert.equal(r.corpo.portal, true); assert.deepEqual(m.b.gravados, ["7961"]);
  const corpo = m.k.corpos.find((x) => x.rota === "POST /externo/portal/register")!.corpo;
  assert.equal(corpo.senha, "senha123"); assert.equal(corpo.paciente.docs.cpf, CPF); assert.equal(corpo.paciente.contatos.email, "j@e.com");
  assert.ok(!m.k.chamadas.includes("POST /externo/register"));
  assert.equal((await tratar(m.ctx, { ...novo, acao: "portal_cadastrar", email: "j@e.com", senha: "senha123" })).corpo.motivo, "ja_cadastrado");
});
test("portal: recuperar senha dá a MESMA resposta exista ou não a conta e tem freio por e-mail", async () => {
  const bom = await tratar(montar({}, banco(), { portal: true }).ctx, { acao: "portal_recuperar", email: "a@b.com", confirmar: true });
  const ruim = await tratar(montar({ recuperar: "erro" }, banco(), { portal: true }).ctx, { acao: "portal_recuperar", email: "a@b.com", confirmar: true });
  assert.deepEqual(bom, ruim);
  const m = montar({}, banco(), { portal: true });
  assert.equal((await tratar(m.ctx, { acao: "portal_recuperar", email: "a@b.com" })).corpo.motivo, "sem_confirmacao");
  for (let i = 0; i < 3; i++) assert.equal((await tratar(m.ctx, { acao: "portal_recuperar", email: "a@b.com", confirmar: true })).corpo.ok, true);
  assert.equal((await tratar(m.ctx, { acao: "portal_recuperar", email: "a@b.com", confirmar: true })).status, 429);
  assert.equal((await tratar(m.ctx, { acao: "portal_recuperar", email: "outro@b.com", confirmar: true })).corpo.ok, true, "o freio é por e-mail");
});
test("resultado de imagem: só com o interruptor do laudo, com identidade, e a sessão manda o nascimento", async () => {
  const off = montar({ paciente: paciente() }, banco(), { resultado: false });
  assert.equal((await tratar(off.ctx, { acao: "resultado_imagem", ...ident, accession: "AN1" })).corpo.motivo, "desligado");
  const m = montar({ paciente: paciente() });
  assert.equal((await tratar(m.ctx, { acao: "resultado_imagem", ...ident, accession: "../x" })).status, 400);
  const r = await tratar(m.ctx, { acao: "resultado_imagem", ...ident, accession: "AN1" });
  assert.equal(r.corpo.ok, true); assert.equal(r.corpo.pronto, true); assert.equal((r.corpo.resultado as any).pdf_base64, "QUJD");
  assert.ok(m.k.urls.some((u) => u.includes("/resultado/pdf/an/AN1?dtnasc=" + NASC)));
  const sem = await tratar(m.ctx, { acao: "resultado_imagem", ...ident, accession: "AN2" });
  assert.equal(sem.corpo.pronto, false); assert.equal(sem.corpo.motivo, "sem_resultado");
});
test("equipe: sem a chave tudo é recusado e nada chega ao Klingo", async () => {
  const m = montar();
  for (const a of ["equipe_atendimentos", "equipe_telefonia"]) { const r = await tratar(m.ctx, { acao: a, rota: "live" }); assert.equal(r.status, 403, a); assert.equal(r.corpo.motivo, "nao_autorizado"); }
  assert.equal(m.k.chamadas.length, 0);
});
test("equipe: atendimentos do dia saem só como totais, sem nenhum dado de paciente", async () => {
  const m = montar({}, banco(), { equipe: true });
  const r = await tratar(m.ctx, { acao: "equipe_atendimentos", data: "2026-11-13" });
  assert.equal(r.corpo.ok, true); assert.equal(r.corpo.total, 2);
  assert.deepEqual(r.corpo.por_medico, [{ nome: "DRA TESTE", total: 2 }]);
  assert.deepEqual((r.corpo.por_procedimento as any[]).map((x) => [x.nome, x.total]), [["CONSULTA", 2], ["ECG", 1]]);
  const txt = JSON.stringify(r.corpo); for (const x of ["Sigiloso", "99999999999", "Sigilo", "71988887777"]) assert.ok(!txt.includes(x), x);
  assert.equal((await tratar(m.ctx, { acao: "equipe_atendimentos", data: "ontem" })).status, 400);
});
test("equipe: telefonia devolve a lista sem nome, CPF, telefone nem id de paciente; confirmar e NPS exigem confirmação", async () => {
  const m = montar({}, banco(), { equipe: true });
  assert.equal((await tratar(m.ctx, { acao: "equipe_telefonia", rota: "live" })).corpo.ok, true);
  const l = await tratar(m.ctx, { acao: "equipe_telefonia", rota: "lista", data: "2026-11-13" });
  assert.equal(l.corpo.total, 1); const txt = JSON.stringify(l.corpo); for (const x of ["Sigiloso", "99999999999", "71988887777", "id_paciente"]) assert.ok(!txt.includes(x), x);
  assert.equal((l.corpo.marcacoes as any[])[0].hora, "09:00");
  assert.equal((await tratar(m.ctx, { acao: "equipe_telefonia", rota: "lista", data: "2026-11-13", ate: "2026-12-30" })).status, 400);
  assert.equal((await tratar(m.ctx, { acao: "equipe_telefonia", rota: "bloqueios", de: "2026-11-01" })).corpo.ok, true);
  assert.equal((await tratar(m.ctx, { acao: "equipe_telefonia", rota: "confirmar", id_marcacao: "9", status: "C" })).corpo.motivo, "sem_confirmacao");
  assert.equal((await tratar(m.ctx, { acao: "equipe_telefonia", rota: "confirmar", id_marcacao: "9", status: "N", confirmar: true })).corpo.motivo, "sem_confirmacao", "N cancela a marcação: pede confirmação extra");
  assert.equal((await tratar(m.ctx, { acao: "equipe_telefonia", rota: "confirmar", id_marcacao: "9", status: "X", confirmar: true })).status, 400);
  assert.equal((await tratar(m.ctx, { acao: "equipe_telefonia", rota: "confirmar", id_marcacao: "9", status: "C", confirmar: true })).corpo.ok, true);
  assert.equal((await tratar(m.ctx, { acao: "equipe_telefonia", rota: "nps", id_marcacao: "9", nota: 11, confirmar: true })).status, 400);
  assert.equal((await tratar(m.ctx, { acao: "equipe_telefonia", rota: "nps", id_marcacao: "9", nota: 10, confirmar: true })).corpo.ok, true);
  assert.equal((await tratar(m.ctx, { acao: "equipe_telefonia", rota: "ultimo_por_cpf" })).status, 400);
});
