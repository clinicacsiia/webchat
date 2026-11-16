// Regras da entrega de laudos no aplicativo (sem Deno e sem rede própria: o Klingo e o banco entram por parâmetro, para testar com dados inventados).
// FLUXOGRAMA: entrada ({acao:"listar"|"baixar", token do aparelho com PIN, id da marcação}) -> validação (o banco confere o aparelho e o PIN dos últimos 30 minutos; cada pessoa só entra
//   depois de a clínica confirmar CPF + nascimento + nome no Klingo; o laudo só é pedido se a marcação saiu da lista de marcações DA PRÓPRIA pessoa) -> lógica (lista = marcações atendidas da pessoa
//   no Klingo; "disponível" só quando o Klingo diz pronto E manda o arquivo; a cada download o Klingo é consultado de novo) -> saída (PDF em base64 SÓ na resposta do download, nunca guardado
//   no banco nem no log; erro do Klingo nunca vira laudo liberado)
// Versão 1.1 — 16/11/2026 / Mudança: ajustada ao formato REAL do Klingo (provado com laudos prontos): `resultado_pdf` é um link assinado do S3 (1 h), baixado aqui e entregue como bytes; a lista confere sem baixar. Versão 1.0 — 16/11/2026: primeira versão (formato do swagger).
import { cpfValido, dataIso, type KlingoApi, KlingoErro } from "./api.ts";

export type Resp = { status: number; corpo: Record<string, unknown> };
export type PessoaCtx = { chave: string; nome: string; nascimento: string; cpf: string | null; eu: boolean; klingo_id: string | null; voucher_em: string | null; situacao?: string | null; verificado_em?: string | null };
export type Arquivo = { nome: string; mime: string; base64: string };
export type Alvo = { id: string };

/** Tudo que a função precisa do banco (cada método é uma RPC só do `service_role`). */
export interface Banco {
  contexto(token: string, renova: boolean): Promise<{ ok: boolean; erro?: string; mensagem?: string; paciente_id?: string; pessoas?: PessoaCtx[] }>;
  pessoaGravar(pac: string, pessoa: string, situacao: string, klingoId: string | null): Promise<void>;
  itensGravar(pac: string, pessoa: string, itens: Array<{ id: string; procedimento: string | null; data: string | null; unidade: string | null }>): Promise<void>;
  aChecar(pac: string, max: number): Promise<string[]>;
  estado(pac: string, marcacao: string, pronto: boolean): Promise<void>;
  lista(pac: string): Promise<Record<string, unknown>>;
  pode(token: string, marcacao: string): Promise<{ ok: boolean; erro?: string; mensagem?: string; paciente_id?: string }>;
  evento(pac: string, tipo: string): Promise<void>;
  /** Quantas conferências deste CPF deram "divergente" na última hora (trava contra quem testa CPFs). */
  divergentesRecentes(cpf: string): Promise<number>;
  registrarIdentidade(cpf: string, nascimento: string, r: { situacao: string; klingo_id?: string }): Promise<void>;
}
/** Busca o PDF no endereço assinado que o Klingo mandou (já validado por urlLaudo) e devolve em base64; null = não é um PDF. Erro de rede lança. */
export type BuscarArquivo = (url: string) => Promise<string | null>;
export type Ctx = { api: Pick<KlingoApi, "chamar" | "pacientePorCpf" | "login">; db: Banco; buscarArquivo: BuscarArquivo; agora?: () => number };

const MAX_PESSOAS = 8;          // titular + filhos (mais que isso não é uso normal)
const MAX_DIVERGENTES_CPF = 5;  // por hora, o mesmo limite do agendamento público
const VOUCHER_VALE_MS = 10 * 60_000;
const FORCAR_APOS_MS = 60_000;
const RETENTAR_NEGADO_MS = 6 * 3600_000;   // quem a clínica não confirmou não é conferido de novo a cada abertura (só depois de 6 h, ou se o CPF/nascimento mudar)
const MAX_CHECAR = 6;
const PARALELO = 3;
const ORCAMENTO_MS = 40_000;
export const MAX_BYTES = 15 * 1024 * 1024;

const nega = (erro: string, mensagem: string, status = 200, extra: Record<string, unknown> = {}): Resp => ({ status, corpo: { ok: false, erro, mensagem, ...extra } });
const ok = (corpo: Record<string, unknown>): Resp => ({ status: 200, corpo: { ok: true, ...corpo } });
const texto = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Nome: mesma regra de public.nome_confere (sem acento, maiúsculas; igual, ou todas as palavras da forma mais curta — pelo menos 2, com mais de 2 letras — estão na mais longa)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const normNome = (t: unknown): string => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
export function nomeConfere(a: unknown, b: unknown): boolean {
  const na = normNome(a), nb = normNome(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [curto, longo] = na.length <= nb.length ? [na, nb] : [nb, na];
  const palavras = curto.split(" ").filter((p) => p.length > 2), alvo = longo.split(" ");
  return palavras.length >= 2 && palavras.every((p) => alvo.includes(p));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Identidade: CPF + nascimento + nome no Klingo. Devolve a sessão do paciente (só para ler as marcações dele).
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type Ident = { situacao: "confere"; klingoId: string; sessao: string; nomeConferido: boolean } | { situacao: "divergente" | "nao_encontrado" | "sem_cadastro" };
export async function identificar(api: Ctx["api"], cpf: string, nascimento: string, nome: string, klingoIdSalvo: string | null): Promise<Ident> {
  let idLogin = klingoIdSalvo && /^P\d+$/.test(klingoIdSalvo) ? klingoIdSalvo : null;
  let nomeApi: string | null = null;
  if (!idLogin) {
    let pac: Record<string, unknown> | null = null;
    try { pac = await api.pacientePorCpf(cpf) as Record<string, unknown> | null; } catch (e) {
      if (e instanceof KlingoErro && e.tipo === "paciente_nao_identificado") return { situacao: "nao_encontrado" };
      throw e;
    }
    if (!pac || pac.id === undefined || pac.id === null || pac.id === "") return { situacao: "nao_encontrado" };
    if (dataIso(pac.dt_nasc) !== nascimento) return { situacao: "divergente" };
    const id = String(pac.id);
    if (!/^P\d+$/.test(id)) return { situacao: "sem_cadastro" };   // pré-cadastro: ainda não tem atendimento nem laudo
    idLogin = id; nomeApi = texto(pac.nome);
  }
  const { token, user } = await api.login(idLogin);
  if (String(user.id ?? "") !== idLogin || dataIso(user.nascimento) !== nascimento) return { situacao: "divergente" };
  const nomeKlingo = texto(user.nome) ?? nomeApi;
  if (nomeKlingo && !nomeConfere(nomeKlingo, nome)) return { situacao: "divergente" };
  return { situacao: "confere", klingoId: idLogin, sessao: token, nomeConferido: !!nomeKlingo };
}

/** GET /vouchers: só as marcações JÁ ATENDIDAS (as canceladas o Klingo nem devolve). */
export async function vouchersAtendidos(api: Ctx["api"], sessao: string): Promise<Array<{ id: string; procedimento: string | null; data: string | null; unidade: string | null }>> {
  const l = await api.chamar<unknown>("GET", "/vouchers", { sessao });
  const saida: Array<{ id: string; procedimento: string | null; data: string | null; unidade: string | null }> = [];
  for (const v of (Array.isArray(l) ? l : []) as Array<Record<string, unknown>>) {
    if (String(v?.status ?? "").toLowerCase() !== "atendido") continue;
    const id = v.id === undefined || v.id === null ? "" : String(v.id);
    if (!/^\d{1,12}$/.test(id)) continue;
    const proc = v.procedimento as Record<string, unknown> | string | undefined, uni = v.unidade as Record<string, unknown> | undefined;
    saida.push({ id, procedimento: (typeof proc === "object" && proc ? texto(proc.descr) : texto(proc))?.slice(0, 200) ?? null, data: dataIso(v.data), unidade: texto(uni?.nome)?.slice(0, 120) ?? null });
  }
  return saida.slice(0, 200);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Resultado: pronto SÓ se o Klingo disser que o laudo está pronto E mandar o conteúdo. Qualquer dúvida = não pronto (nunca libera por engano).
// ---------------------------------------------------------------------------------------------------------------------------------------------
const verdade = (v: unknown) => v === true || v === 1 || v === "1" || (typeof v === "string" && ["s", "sim", "true"].includes(v.trim().toLowerCase()));
/** O Klingo documenta {lista:[laudo]}; aceita também a lista direta ou um laudo solto. */
export function extrairLaudos(r: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(r)) return r.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>;
  if (r && typeof r === "object") {
    const lista = (r as Record<string, unknown>).lista;
    if (Array.isArray(lista)) return lista.filter((x) => x && typeof x === "object") as Array<Record<string, unknown>>;
    return [r as Record<string, unknown>];
  }
  return [];
}
/** Base64 de PDF de verdade (começa com %PDF), sem prefixo de data: URL e sem quebras de linha. Outra coisa = null. */
export function pdfBase64(v: unknown): string | null {
  const t = String(v ?? "").trim().replace(/^data:application\/pdf;base64,/i, "").replace(/\s+/g, "");
  if (!t || !/^[A-Za-z0-9+/]+={0,2}$/.test(t) || !t.startsWith("JVBER")) return null;
  return t.length * 0.75 > MAX_BYTES ? null : t;
}
/**
 * FORMATO REAL (provado em 16/11/2026 com laudos prontos): GET /resultado/{id} devolve {lista:[{pronto, status, resultado_pdf, resultado_html, ...}]} e, quando pronto, `resultado_pdf` NÃO é o PDF:
 * é um link assinado do S3 (vale 1 hora) para o PDF. Só aceitamos o endereço da clínica (https, host s3.amazonaws.com, pasta dos laudos da CSI, terminando em .pdf).
 * O link nunca vai para o paciente, para o banco nem para o log: a função baixa o arquivo e entrega os bytes.
 */
export const URL_LAUDO = { host: "s3.amazonaws.com", pasta: "/arquivos.azuremed/clientes/clinicacsi/laudos/" };
export function urlLaudo(v: unknown): string | null {
  const t = String(v ?? "").trim();
  if (!t || t.length > 2000) return null;
  let u: URL;
  try { u = new URL(t); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== URL_LAUDO.host || u.port || u.username || u.password) return null;
  if (!u.pathname.startsWith(URL_LAUDO.pasta) || !/^[A-Za-z0-9_.\/-]+\.pdf$/.test(u.pathname) || u.pathname.includes("..")) return null;
  return u.toString();
}
export function bytesParaBase64(b: Uint8Array): string {
  let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
const nomeArquivo = (proc: unknown, i: number, ext: string) => {
  const base = normNome(typeof proc === "object" && proc ? (proc as Record<string, unknown>).descr : proc).toLowerCase().replace(/ /g, "-").slice(0, 50);
  return `laudo${base ? "-" + base : ""}${i > 0 ? "-" + (i + 1) : ""}.${ext}`;
};
export type Leitura = { pronto: boolean; arquivos: Arquivo[] };
/**
 * baixar=false (conferir a lista): só confirma que o Klingo diz "pronto" E aponta um arquivo válido, sem baixar o PDF (arquivos vêm com base64 vazio).
 * baixar=true (o paciente tocou em Baixar): busca o PDF de verdade. Falha ao buscar o arquivo LANÇA erro (nunca vira "retirado" nem "pronto").
 */
export async function lerResultado(ctx: Pick<Ctx, "api" | "buscarArquivo">, id: string, baixar = true): Promise<Leitura> {
  const api = ctx.api;
  const semResultado = (e: unknown) => e instanceof KlingoErro && (e.tipo === "html" || e.status === 403 || e.status === 404);
  let r: unknown;
  try { r = await api.chamar<unknown>("GET", `/resultado/${encodeURIComponent(id)}`); } catch (e) { if (semResultado(e)) return { pronto: false, arquivos: [] }; throw e; }
  const prontos = extrairLaudos(r).filter((l) => verdade(l.pronto));   // rascunho (pronto=false) pode trazer o texto do laudo: é ignorado de propósito
  if (!prontos.length) return { pronto: false, arquivos: [] };
  const arquivos: Arquivo[] = [];
  for (const [i, l] of prontos.entries()) {
    const bruto = l.resultado_pdf ?? l.pdf ?? l.pdf_base64;
    const direto = pdfBase64(bruto), url = direto ? null : urlLaudo(bruto);
    if (direto) arquivos.push({ nome: nomeArquivo(l.procedimento, i, "pdf"), mime: "application/pdf", base64: direto });
    else if (url) {
      if (!baixar) { arquivos.push({ nome: nomeArquivo(l.procedimento, i, "pdf"), mime: "application/pdf", base64: "" }); continue; }
      const b64 = await ctx.buscarArquivo(url);
      if (!b64) throw new Error("arquivo");   // o endereço não devolveu um PDF: não entrega, e também não conta como "retirado"
      arquivos.push({ nome: nomeArquivo(l.procedimento, i, "pdf"), mime: "application/pdf", base64: b64 });
    }
  }
  if (!arquivos.length) {   // laudo laboratorial: o PDF pode vir pela rota própria (exame de imagem responde 403 aqui)
    try {
      const r2 = await api.chamar<unknown>("GET", `/resultado/pdf/${encodeURIComponent(id)}`);
      const pdf = pdfBase64((r2 as Record<string, unknown> | null)?.pdf_base64 ?? (r2 as Record<string, unknown> | null)?.pdf);
      if (pdf) arquivos.push({ nome: nomeArquivo(null, 0, "pdf"), mime: "application/pdf", base64: baixar ? pdf : "" });
    } catch (e) { if (!semResultado(e)) throw e; }
  }
  if (!arquivos.length) {   // sem PDF, mas com o texto do laudo pronto: entrega o texto como arquivo (nunca é mostrado dentro do aplicativo)
    prontos.forEach((l, i) => {
      const html = texto(l.resultado_html ?? l.html);
      if (html && html.length < 2_000_000) arquivos.push({ nome: nomeArquivo(l.procedimento, i, "html"), mime: "text/html", base64: baixar ? btoa(unescape(encodeURIComponent(html))) : "" });
    });
  }
  return { pronto: arquivos.length > 0, arquivos };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Ações
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function atualizarPessoa(ctx: Ctx, pac: string, p: PessoaCtx, forcar: boolean): Promise<void> {
  const agora = (ctx.agora ?? Date.now)();
  const cpf = cpfValido(p.cpf);
  if (!cpf) return;
  const idade = p.voucher_em ? agora - Date.parse(p.voucher_em) : Infinity;
  if (p.klingo_id && idade < (forcar ? FORCAR_APOS_MS : VOUCHER_VALE_MS)) return;   // lista recente: não incomoda o Klingo
  if (!p.klingo_id && p.situacao && ["divergente", "nao_encontrado", "sem_cadastro"].includes(p.situacao) && p.verificado_em && agora - Date.parse(p.verificado_em) < RETENTAR_NEGADO_MS) return;
  if (!p.klingo_id && (await ctx.db.divergentesRecentes(cpf)) >= MAX_DIVERGENTES_CPF) { await ctx.db.pessoaGravar(pac, p.chave, "travado", null); return; }   // quem já foi confirmado não é travado
  let id: Ident;
  try { id = await identificar(ctx.api, cpf, p.nascimento, p.nome, p.klingo_id); } catch { return; }   // Klingo fora do ar: mantém o que já estava
  if (id.situacao !== "confere") {
    if (id.situacao === "divergente") await ctx.db.registrarIdentidade(cpf, p.nascimento, { situacao: "divergente" }).catch(() => {});
    await ctx.db.pessoaGravar(pac, p.chave, id.situacao, null);
    return;
  }
  await ctx.db.pessoaGravar(pac, p.chave, "confere", id.klingoId);
  try { await ctx.db.itensGravar(pac, p.chave, await vouchersAtendidos(ctx.api, id.sessao)); } catch { /* Klingo oscilou: tenta de novo na próxima abertura */ }
}

async function conferirLaudos(ctx: Ctx, pac: string, inicio: number): Promise<void> {
  const ids = await ctx.db.aChecar(pac, MAX_CHECAR);
  const agora = ctx.agora ?? Date.now;
  for (let i = 0; i < ids.length && agora() - inicio < ORCAMENTO_MS; i += PARALELO) {
    await Promise.all(ids.slice(i, i + PARALELO).map(async (id) => {
      try { const r = await lerResultado(ctx, id, false); await ctx.db.estado(pac, id, r.pronto); } catch { /* sem resposta do Klingo: o estado anterior fica e é conferido de novo depois */ }
    }));
  }
}

export async function listar(ctx: Ctx, c: { token: string; forcar: boolean }): Promise<Resp> {
  const inicio = (ctx.agora ?? Date.now)();
  const x = await ctx.db.contexto(c.token, false);
  if (!x.ok || !x.paciente_id) return nega(x.erro ?? "sessao", x.mensagem ?? "Entre de novo com o seu celular e PIN.");
  for (const p of (x.pessoas ?? []).slice(0, MAX_PESSOAS)) await atualizarPessoa(ctx, x.paciente_id, p, c.forcar);
  await conferirLaudos(ctx, x.paciente_id, inicio);
  return ok(await ctx.db.lista(x.paciente_id));
}

export async function baixar(ctx: Ctx, c: { token: string; id: string }): Promise<Resp> {
  if (!/^\d{1,12}$/.test(c.id)) return nega("id", "Laudo não encontrado.", 400);
  const p = await ctx.db.pode(c.token, c.id);
  if (!p.ok || !p.paciente_id) return nega(p.erro ?? "sem_acesso", p.mensagem ?? "Laudo não encontrado.");
  let r: Leitura;
  try { r = await lerResultado(ctx, c.id, true); } catch { return nega("klingo", "Não foi possível consultar a clínica agora. Tente de novo em instantes."); }   // na dúvida, NÃO entrega
  if (!r.pronto || !r.arquivos.length) {
    await ctx.db.estado(p.paciente_id, c.id, false).catch(() => {});
    await ctx.db.evento(p.paciente_id, "laudo_bloqueado").catch(() => {});
    return nega("indisponivel", "Este laudo está em revisão pela equipe e não pode ser baixado agora. Assim que for liberado de novo, ele volta a aparecer aqui.");
  }
  await ctx.db.estado(p.paciente_id, c.id, true).catch(() => {});
  await ctx.db.evento(p.paciente_id, "laudo_baixado").catch(() => {});
  return ok({ arquivos: r.arquivos });
}

/** Ponto único de entrada: o corpo JSON já lido. */
export async function tratar(ctx: Ctx, c: Record<string, unknown>): Promise<Resp> {
  const acao = String(c?.acao ?? "");
  if (acao === "versao") return ok({ versao: "1.1" });
  const token = typeof c.token === "string" ? c.token : "";
  if (!token || token.length > 200) return nega("sessao", "Entre de novo com o seu celular e PIN.", 400);
  if (acao === "listar") return listar(ctx, { token, forcar: c.forcar === true });
  if (acao === "baixar") return baixar(ctx, { token, id: String(c.id ?? "") });
  return nega("acao_invalida", "Pedido inválido.", 400);
}
