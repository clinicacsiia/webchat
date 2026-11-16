// FLUXOGRAMA: entrada (Klingo e banco INVENTADOS, em memória) -> validação (identidade CPF + nascimento + nome; aparelho sem PIN) -> lógica (listar, baixar, laudo retirado pela equipe, Klingo fora do ar) -> saída (PASS/FAIL)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial. Nenhum dado real: os formatos de laudo seguem o swagger (lista[].resultado_pdf), que NUNCA foi provado com laudo real.
import test from "node:test";
import assert from "node:assert/strict";
import { baixar, type Banco, type Ctx, extrairLaudos, identificar, listar, lerResultado, nomeConfere, pdfBase64, type PessoaCtx, tratar } from "./laudos.ts";
import { KlingoErro } from "./api.ts";

const PDF = "JVBERi0xLjQKJSBsYXVkbyBkZSB0ZXN0ZQ==";   // "%PDF-1.4 ... teste"
const CPF = "52998224725", NASC = "1988-04-12", NASC_LEO = "2019-08-30", CPF_LEO = "11144477735";
type Cenario = {
  pacientes?: Record<string, { id: string; dt_nasc: string; nome?: string }>;     // por CPF
  logins?: Record<string, { nascimento: string; nome?: string }>;                  // por id P…
  vouchers?: Record<string, Array<Record<string, unknown>>>;                       // por id P…
  resultados?: Record<string, unknown>;                                            // por marcação: corpo ou "403"
  pdfs?: Record<string, unknown>;                                                  // /resultado/pdf/{id}
  foraDoAr?: boolean;
};
function klingoFalso(c: Cenario) {
  const chamadas: string[] = [];
  const api = {
    async pacientePorCpf(cpf: string) { chamadas.push("cpf"); const p = c.pacientes?.[cpf]; if (!p) throw new KlingoErro(403, "/paciente/cpf", "paciente_nao_identificado"); return p as unknown as Record<string, unknown>; },
    async login(id: string) { chamadas.push("login"); const l = c.logins?.[id]; if (!l) throw new KlingoErro(403, "/externo/login", "outro"); return { token: "sessao-" + id, user: { id, nascimento: l.nascimento, ...(l.nome ? { nome: l.nome } : {}) } }; },
    async chamar<T>(metodo: string, caminho: string, o: { sessao?: string } = {}): Promise<T> {
      chamadas.push(`${metodo} ${caminho}`);
      if (c.foraDoAr) throw new KlingoErro(0, caminho, "timeout");
      if (caminho === "/vouchers") return (c.vouchers?.[(o.sessao ?? "").replace("sessao-", "")] ?? []) as T;
      let m = caminho.match(/^\/resultado\/pdf\/(\d+)$/);
      if (m) { const r = c.pdfs?.[m[1]]; if (r === undefined || r === "403") throw new KlingoErro(403, caminho, "html"); return r as T; }
      m = caminho.match(/^\/resultado\/(\d+)$/);
      if (m) { const r = c.resultados?.[m[1]]; if (r === undefined || r === "403") throw new KlingoErro(403, caminho, "html"); return r as T; }
      throw new KlingoErro(404, caminho, "outro");
    },
  };
  return { api, chamadas };
}
// Banco em memória que imita as regras do SQL (aparelho, pessoas, itens, estado). O SQL em si é provado em testes/sql-laudos-no-app.test.mjs.
function bancoFalso(opts: { pessoas: PessoaCtx[]; pinValido?: boolean }) {
  const st = { pessoas: opts.pessoas, itens: new Map<string, { pessoa: string; procedimento: string | null; data: string | null; estado: string }>(), eventos: [] as string[], pinValido: opts.pinValido ?? true, divergentes: 0, gravouPessoa: [] as string[] };
  const PAC = "pac-1";
  const db: Banco = {
    async contexto(_t, _r) { return st.pinValido ? { ok: true, paciente_id: PAC, pessoas: st.pessoas } : { ok: false, erro: "bloqueado", mensagem: "Digite seu PIN para continuar." }; },
    async pessoaGravar(_p, pessoa, situacao, klingoId) {
      st.gravouPessoa.push(`${pessoa}:${situacao}`);
      const p = st.pessoas.find((x) => x.chave === pessoa)!; p.situacao = situacao; p.verificado_em = new Date().toISOString();
      if (situacao === "confere") p.klingo_id = klingoId; else if (["divergente", "nao_encontrado", "sem_cadastro"].includes(situacao)) { p.klingo_id = null; for (const [k, v] of st.itens) if (v.pessoa === pessoa) st.itens.delete(k); }
    },
    async itensGravar(_p, pessoa, itens) { for (const i of itens) st.itens.set(i.id, { pessoa, procedimento: i.procedimento, data: i.data, estado: st.itens.get(i.id)?.estado ?? "aguardando" }); st.pessoas.find((x) => x.chave === pessoa)!.voucher_em = new Date().toISOString(); },
    async aChecar() { return [...st.itens.keys()]; },
    async estado(_p, id, pronto) { const i = st.itens.get(id); if (!i) return; i.estado = pronto ? "disponivel" : i.estado === "disponivel" || i.estado === "em_revisao" ? "em_revisao" : "aguardando"; },
    async lista() { return { itens: [...st.itens].map(([id, v]) => ({ id, ...v })), pessoas: st.pessoas.map((p) => ({ nome: p.nome, situacao: p.situacao ?? "pendente" })) }; },
    async pode(_t, id) { return !st.pinValido ? { ok: false, erro: "bloqueado" } : st.itens.has(id) ? { ok: true, paciente_id: PAC } : { ok: false, erro: "sem_acesso", mensagem: "Laudo não encontrado." }; },
    async evento(_p, tipo) { st.eventos.push(tipo); },
    async divergentesRecentes() { return st.divergentes; },
    async registrarIdentidade() { st.divergentes++; },
  };
  return { db, st };
}
const ana = (extra: Partial<PessoaCtx> = {}): PessoaCtx => ({ chave: "eu", nome: "Ana Souza Teste", nascimento: NASC, cpf: CPF, eu: true, klingo_id: null, voucher_em: null, ...extra });
const voucher = (id: number, proc = "RM JOELHO DIREITO", status = "atendido") => ({ id, status, data: "2026-11-10", hora: "08:40", procedimento: { descr: proc }, unidade: { nome: "Centro" } });
const laudoOk = (pronto = true) => ({ lista: [{ id_laudo: 1, pronto, status: pronto ? "Liberado" : "Em revisão", procedimento: { descr: "RM JOELHO DIREITO" }, resultado_pdf: PDF }] });
const mundo = (c: Cenario = {}, pessoas: PessoaCtx[] = [ana()], pinValido = true) => {
  const base: Cenario = { pacientes: { [CPF]: { id: "P100", dt_nasc: NASC, nome: "ANA SOUZA TESTE" } }, logins: { P100: { nascimento: NASC, nome: "Ana Souza Teste" } }, vouchers: { P100: [voucher(501), voucher(502, "US ABDOME TOTAL"), voucher(503, "CONSULTA", "agendado")] }, resultados: { "501": laudoOk(), "502": "403" } };
  const k = klingoFalso({ ...base, ...c }); const b = bancoFalso({ pessoas, pinValido });
  return { ctx: { api: k.api, db: b.db } as Ctx, k, b };
};

test("nomeConfere segue a regra do banco (acento, caixa, nome do meio, nomes diferentes)", () => {
  assert.equal(nomeConfere("ANA SOUZA TESTE", "Ana Souza Teste"), true);
  assert.equal(nomeConfere("Ana Maria Souza", "ANA SOUZA"), true);
  assert.equal(nomeConfere("JOÃO PEREIRA LIMA", "Joao Pereira Lima"), true);
  assert.equal(nomeConfere("Ana Souza", "Bia Souza"), false);
  assert.equal(nomeConfere("Ana", "Ana Souza Teste"), false, "uma palavra só não confirma");
  assert.equal(nomeConfere("", "Ana Souza"), false);
});

test("pdfBase64 só aceita PDF de verdade (começa com %PDF), sem prefixo nem quebras", () => {
  assert.equal(pdfBase64(PDF), PDF);
  assert.equal(pdfBase64("data:application/pdf;base64," + PDF), PDF);
  assert.equal(pdfBase64(PDF.slice(0, 10) + "\n" + PDF.slice(10)), PDF);
  assert.equal(pdfBase64("PGh0bWw+"), null, "html em base64 não é PDF");
  assert.equal(pdfBase64(""), null);
  assert.equal(pdfBase64("não é base64!"), null);
});

test("extrairLaudos aceita {lista:[...]}, lista direta e laudo solto", () => {
  assert.equal(extrairLaudos({ lista: [{ pronto: true }, { pronto: false }] }).length, 2);
  assert.equal(extrairLaudos([{ pronto: true }]).length, 1);
  assert.equal(extrairLaudos({ pronto: true, pdf: PDF }).length, 1);
  assert.equal(extrairLaudos(null).length, 0);
  assert.equal(extrairLaudos("<html>").length, 0);
});

test("lerResultado: pronto + PDF = entrega; sem 'pronto' ou pronto=false = nada; 403 em HTML = ainda sem laudo", async () => {
  const { k } = mundo({ resultados: { "1": laudoOk(), "2": laudoOk(false), "3": { lista: [{ resultado_pdf: PDF }] }, "4": "403", "5": { lista: [{ pronto: true, status: "ok" }] } }, pdfs: { "5": { id_marcacao: "5", pdf_base64: PDF } } });
  assert.equal((await lerResultado(k.api, "1")).arquivos.length, 1);
  assert.equal((await lerResultado(k.api, "1")).arquivos[0].mime, "application/pdf");
  assert.equal((await lerResultado(k.api, "2")).pronto, false, "pronto=false: não entrega, mesmo com o PDF na resposta");
  assert.equal((await lerResultado(k.api, "3")).pronto, false, "sem o campo pronto: na dúvida, não entrega");
  assert.equal((await lerResultado(k.api, "4")).pronto, false);
  const lab = await lerResultado(k.api, "5");
  assert.equal(lab.pronto, true, "laboratório: o PDF vem pela rota /resultado/pdf/{id}");
  assert.equal(lab.arquivos[0].base64, PDF);
});

test("lerResultado: pronto sem nenhum arquivo = não pronto; só HTML vira arquivo .html; erro de rede NÃO vira 'sem laudo'", async () => {
  const a = mundo({ resultados: { "1": { lista: [{ pronto: true }] } } });
  assert.equal((await lerResultado(a.k.api, "1")).pronto, false);
  const b = mundo({ resultados: { "1": { lista: [{ pronto: true, resultado_html: "<p>laudo</p>" }] } } });
  const r = await lerResultado(b.k.api, "1");
  assert.equal(r.pronto, true); assert.equal(r.arquivos[0].mime, "text/html"); assert.match(r.arquivos[0].nome, /\.html$/);
  const c = mundo({ foraDoAr: true });
  await assert.rejects(() => lerResultado(c.k.api, "1"), (e: unknown) => e instanceof KlingoErro && e.tipo === "timeout");
});

test("lerResultado: dois laudos na mesma marcação, um pronto e um em revisão: só o pronto sai", async () => {
  const { k } = mundo({ resultados: { "7": { lista: [{ pronto: true, resultado_pdf: PDF, procedimento: { descr: "RX TORAX" } }, { pronto: false, resultado_pdf: PDF, procedimento: { descr: "RX COLUNA" } }] } } });
  const r = await lerResultado(k.api, "7");
  assert.equal(r.arquivos.length, 1); assert.match(r.arquivos[0].nome, /rx-torax/);
});

test("identificar: confere com CPF + nascimento + nome; nascimento errado, nome diferente e CPF desconhecido são recusados", async () => {
  const m = mundo();
  const a = await identificar(m.k.api, CPF, NASC, "Ana Souza Teste", null);
  assert.equal(a.situacao, "confere"); if (a.situacao === "confere") { assert.equal(a.klingoId, "P100"); assert.equal(a.nomeConferido, true); }
  assert.equal((await identificar(m.k.api, CPF, "1990-01-01", "Ana Souza Teste", null)).situacao, "divergente");
  assert.equal((await identificar(m.k.api, CPF, NASC, "Carla Pereira Lima", null)).situacao, "divergente", "CPF e nascimento certos, mas o nome é de outra pessoa");
  assert.equal((await identificar(m.k.api, "11144477735", NASC, "Ana Souza Teste", null)).situacao, "nao_encontrado");
  const pre = mundo({ pacientes: { [CPF]: { id: "123", dt_nasc: NASC } } });
  assert.equal((await identificar(pre.k.api, CPF, NASC, "Ana Souza Teste", null)).situacao, "sem_cadastro", "pré-cadastro (sem P) não tem atendimento");
  const sessao = mundo({ logins: { P100: { nascimento: "1999-09-09" } } });
  assert.equal((await identificar(sessao.k.api, CPF, NASC, "Ana Souza Teste", "P100")).situacao, "divergente", "a sessão também confere o nascimento");
});

test("listar: paciente que nunca usou o chat vê os exames atendidos e o laudo pronto; o que não tem laudo fica aguardando", async () => {
  const m = mundo();
  const r = await listar(m.ctx, { token: "t", forcar: false });
  assert.equal(r.corpo.ok, true);
  const itens = r.corpo.itens as Array<{ id: string; estado: string }>;
  assert.deepEqual(itens.map((i) => i.id).sort(), ["501", "502"], "só marcação atendida; a agendada não entra");
  assert.equal(itens.find((i) => i.id === "501")!.estado, "disponivel");
  assert.equal(itens.find((i) => i.id === "502")!.estado, "aguardando");
  assert.equal(JSON.stringify(r.corpo).includes(PDF), false, "a lista nunca carrega o PDF");
  assert.equal(JSON.stringify(r.corpo).includes(CPF), false, "nem o CPF");
});

test("listar: lista recente não chama o Klingo de novo (cota); 'forcar' só vale depois de 60 s", async () => {
  const m = mundo();
  await listar(m.ctx, { token: "t", forcar: false });
  const antes = m.k.chamadas.filter((c) => c === "GET /vouchers").length;
  await listar(m.ctx, { token: "t", forcar: false });
  await listar(m.ctx, { token: "t", forcar: true });
  assert.equal(m.k.chamadas.filter((c) => c === "GET /vouchers").length, antes, "voucher lido uma vez só");
});

test("listar: PIN vencido ou aparelho desconhecido = nada vai ao Klingo", async () => {
  const m = mundo({}, [ana()], false);
  const r = await listar(m.ctx, { token: "t", forcar: false });
  assert.equal(r.corpo.ok, false); assert.equal(r.corpo.erro, "bloqueado");
  assert.equal(m.k.chamadas.length, 0);
});

test("listar: CPF de outra pessoa (nascimento não bate) = nenhuma marcação, nenhum laudo, e a tentativa é registrada", async () => {
  const m = mundo({}, [ana({ nascimento: "1999-01-01" })]);
  const r = await listar(m.ctx, { token: "t", forcar: false });
  assert.equal((r.corpo.itens as unknown[]).length, 0);
  assert.equal(m.b.st.divergentes, 1);
  assert.equal(m.k.chamadas.includes("GET /vouchers"), false, "nem chegou a abrir sessão");
  const de_novo = await listar(m.ctx, { token: "t", forcar: false });
  assert.equal(m.b.st.divergentes, 1, "não conferiu de novo a cada abertura da tela");
  assert.equal((de_novo.corpo.itens as unknown[]).length, 0);
});

test("listar: trava por CPF depois de 5 conferências erradas na hora (quem tenta adivinhar CPFs)", async () => {
  const m = mundo({}, [ana()]);
  m.b.st.divergentes = 5;
  const r = await listar(m.ctx, { token: "t", forcar: false });
  assert.equal((r.corpo.itens as unknown[]).length, 0);
  assert.equal(m.k.chamadas.length, 0, "travado antes de qualquer chamada ao Klingo");
  assert.ok(m.b.st.gravouPessoa.includes("eu:travado"));
});

test("listar: filho entra com o CPF e o nascimento dele; titular sem CPF é pulado sem erro", async () => {
  const leo: PessoaCtx = { chave: "f1", nome: "Leo Souza Teste", nascimento: NASC_LEO, cpf: CPF_LEO, eu: false, klingo_id: null, voucher_em: null };
  const m = mundo({ pacientes: { [CPF]: { id: "P100", dt_nasc: NASC, nome: "ANA SOUZA TESTE" }, [CPF_LEO]: { id: "P200", dt_nasc: NASC_LEO, nome: "LEO SOUZA TESTE" } },
    logins: { P100: { nascimento: NASC, nome: "Ana Souza Teste" }, P200: { nascimento: NASC_LEO, nome: "Leo Souza Teste" } },
    vouchers: { P100: [voucher(501)], P200: [voucher(601, "TC TORAX")] }, resultados: { "501": laudoOk(), "601": laudoOk() } }, [ana({ cpf: null }), leo]);
  const r = await listar(m.ctx, { token: "t", forcar: false });
  const itens = r.corpo.itens as Array<{ id: string }>;
  assert.deepEqual(itens.map((i) => i.id), ["601"], "o titular está sem CPF e não é conferido; o filho sim");
});

test("listar: Klingo fora do ar não derruba a tela nem apaga o que já se sabia", async () => {
  const m = mundo({ foraDoAr: true }, [ana({ klingo_id: "P100", voucher_em: new Date(0).toISOString() })]);
  m.b.st.itens.set("501", { pessoa: "eu", procedimento: "RM", data: "2026-11-10", estado: "disponivel" });
  const r = await listar(m.ctx, { token: "t", forcar: false });
  assert.equal(r.corpo.ok, true);
  assert.equal((r.corpo.itens as Array<{ estado: string }>)[0].estado, "disponivel", "o estado anterior fica até o Klingo responder");
});

test("baixar: laudo pronto entrega o PDF; cada clique consulta o Klingo de novo; dá para baixar quantas vezes quiser", async () => {
  const m = mundo();
  await listar(m.ctx, { token: "t", forcar: false });
  const antes = m.k.chamadas.filter((c) => c === "GET /resultado/501").length;
  for (let i = 0; i < 3; i++) {
    const r = await baixar(m.ctx, { token: "t", id: "501" });
    assert.equal(r.corpo.ok, true);
    assert.equal((r.corpo.arquivos as Array<{ base64: string }>)[0].base64, PDF);
  }
  assert.equal(m.k.chamadas.filter((c) => c === "GET /resultado/501").length, antes + 3, "uma consulta ao Klingo por download");
  assert.equal(m.b.st.eventos.filter((e) => e === "laudo_baixado").length, 3);
});

test("baixar: a equipe RETIRA o laudo para ajuste no Klingo -> o download é bloqueado na hora e a lista passa a 'em revisão'", async () => {
  const m = mundo();
  await listar(m.ctx, { token: "t", forcar: false });
  assert.equal((await baixar(m.ctx, { token: "t", id: "501" })).corpo.ok, true);
  (m.k.api as unknown as { chamar: unknown }).chamar = undefined;   // troca o cenário abaixo
  const k2 = klingoFalso({ resultados: { "501": laudoOk(false) } });
  const ctx2: Ctx = { api: k2.api, db: m.ctx.db };
  const r = await baixar(ctx2, { token: "t", id: "501" });
  assert.equal(r.corpo.ok, false); assert.equal(r.corpo.erro, "indisponivel"); assert.equal(r.corpo.arquivos, undefined, "nenhum arquivo sai");
  assert.equal(m.b.st.itens.get("501")!.estado, "em_revisao");
  assert.ok(m.b.st.eventos.includes("laudo_bloqueado"));
  // a equipe retira de outro jeito: o Klingo passa a responder 403 em HTML
  const k3 = klingoFalso({ resultados: { "501": "403" } });
  assert.equal((await baixar({ api: k3.api, db: m.ctx.db }, { token: "t", id: "501" })).corpo.ok, false);
  // liberou de novo
  const k4 = klingoFalso({ resultados: { "501": laudoOk(true) } });
  assert.equal((await baixar({ api: k4.api, db: m.ctx.db }, { token: "t", id: "501" })).corpo.ok, true);
  assert.equal(m.b.st.itens.get("501")!.estado, "disponivel");
});

test("baixar: Klingo fora do ar NÃO entrega (nunca libera na dúvida) e não marca como retirado", async () => {
  const m = mundo();
  await listar(m.ctx, { token: "t", forcar: false });
  const k2 = klingoFalso({ foraDoAr: true });
  const r = await baixar({ api: k2.api, db: m.ctx.db }, { token: "t", id: "501" });
  assert.equal(r.corpo.ok, false); assert.equal(r.corpo.erro, "klingo");
  assert.equal(m.b.st.itens.get("501")!.estado, "disponivel", "queda de rede não significa laudo retirado");
});

test("baixar: marcação que não é de nenhuma pessoa do cadastro, PIN vencido e id malformado são recusados sem chamar o Klingo", async () => {
  const m = mundo();
  await listar(m.ctx, { token: "t", forcar: false });
  const n = m.k.chamadas.length;
  assert.equal((await baixar(m.ctx, { token: "t", id: "999" })).corpo.ok, false);
  assert.equal((await baixar(m.ctx, { token: "t", id: "501; drop" })).corpo.ok, false);
  assert.equal((await baixar(m.ctx, { token: "t", id: "../501" })).status, 400);
  m.b.st.pinValido = false;
  assert.equal((await baixar(m.ctx, { token: "t", id: "501" })).corpo.ok, false);
  assert.equal(m.k.chamadas.length, n, "nenhuma chamada ao Klingo");
});

test("tratar: ação desconhecida, corpo sem token e versão", async () => {
  const m = mundo();
  assert.equal((await tratar(m.ctx, { acao: "x", token: "t" })).status, 400);
  assert.equal((await tratar(m.ctx, { acao: "listar" })).status, 400);
  assert.equal((await tratar(m.ctx, { acao: "versao" })).corpo.versao, "1.0");
});
