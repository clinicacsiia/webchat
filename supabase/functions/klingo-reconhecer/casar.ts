// FLUXOGRAMA: entrada (um pedido do chat: nome, telefones, exames pedidos e quando a conversa começou + as marcações CRIADAS no Klingo desde então, do relatório #13825) -> validação (identidade: prontuário já conferido, ou nome completo igual com ou sem telefone; marcação ABERTA e feita depois que a conversa começou) -> lógica (confere se o exame bate com o pedido; escolhe a(s) marcação(ões) do paciente; recusa o ambíguo) -> saída (veredito por pedido: identidade, marcações com data/hora/unidade REAIS e como o exame bateu; nunca devolve nome nem telefone)
// Versão 1.1 — 10/11/2026 / Mudança: prontuário já conferido entra primeiro (AGE-01). Versão 1.0: reconhecer por nome completo e exame, também em conversa já encerrada (WC-02 v3)
//
// Tudo aqui é função pura (sem rede, sem banco). As linhas do Klingo trazem nome e telefone de pacientes: ficam só na memória da Edge Function.
// Colunas do #13825: col0 Id da Marcação, col2 Prontuário, col3 Agendado Em (quando foi marcado), col4 Agendado Para (a data do exame), col5 Procedimento,
// col11 Cancelamento - Motivo, col12 Status (Aberta/Cancelada), col14 Unidade, col15 Nome, col16 Celular, col17 Telefone. O valor (col8) NUNCA é lido.

export type Row = Record<string, unknown>;
export type Alvo = { id: string; conv_criada: string; nome: string; fones: string[]; itens: string[]; prontuarios?: string[] };
export type Compat = "exato" | "familia";
export type Marcacao = { id: string; proc: string; unidade: string; para: string; em: string; compat: Compat };
export type Identidade = "forte" | "medio";
export type Resultado = { id: string; identidade: Identidade | null; marcacoes: Marcacao[]; ambiguo: boolean; cadastros: number; fracos: number; outros_exames: number; por_prontuario: boolean };

const txt = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);

// Mesma normalização de public.norm_nome: maiúsculas, sem acento, só letras e espaços.
export const normNome = (t: unknown): string =>
  String(t ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();

// Últimos 8 dígitos de cada telefone do campo (aceita vários números, com ou sem DDD, com máscara).
export function fonesDaLinha(t: unknown): string[] {
  const out: string[] = [];
  for (const m of String(t ?? "").matchAll(/\d[\d\s().+-]{6,}\d/g)) {
    const d = m[0].replace(/\D/g, "");
    if (d.length < 8) continue;
    if (d.length <= 13) out.push(d.slice(-8));
    else for (let i = 0; i + 8 <= d.length; i++) out.push(d.slice(i, i + 8));
  }
  return out;
}

// Igual, ou o nome mais curto (2+ palavras de mais de 2 letras) contido no mais longo (mesmo critério de public.nome_confere).
export function nomeConfere(a: unknown, b: unknown): boolean {
  const na = normNome(a), nb = normNome(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [curto, longo] = na.length <= nb.length ? [na, nb] : [nb, na];
  const palavras = new Set(longo.split(" "));
  const chaves = curto.split(" ").filter((t) => t.length > 2);
  return chaves.length >= 2 && chaves.every((t) => palavras.has(t));
}

// "2026-11-09 12:57:00" (hora de Brasília, UTC-3, sem fuso no texto) -> milissegundos.
export const paraMs = (s: string): number => Date.parse(String(s).trim().slice(0, 19).replace(" ", "T") + "-03:00");

// Família do exame: consulta, ou a primeira palavra (RM, TC, US, RX, MAMO...). USG = US; MAMOGRAFIA = MAMO.
export function familia(proc: string): string {
  const n = normNome(proc);
  if (/^(CONSULTA|ATENDIMENTO)\b/.test(n)) return "CONSULTA";
  const p = n.split(" ")[0] ?? "";
  return p === "USG" ? "US" : p.startsWith("MAMOGRAFIA") ? "MAMO" : p.startsWith("DENSITOMETRIA") ? "DENSITO" : p;
}

// Como o exame do Klingo bate com o pedido do chat:
//  exato   = mesmo nome, ou um contido no outro ("CONSULTA" no Klingo para "CONSULTA ORTOPEDIATRA" no chat, e vice-versa)
//  familia = mesma família (as duas são consulta, ou as duas são RM...) mas com nome diferente
//  null    = outro tipo de exame
export function compat(procKlingo: string, itens: string[]): Compat | null {
  const np = normNome(procKlingo);
  if (!np || itens.length === 0) return null;
  for (const it of itens) {
    const ni = normNome(it);
    if (!ni) continue;
    if (ni === np) return "exato";
    const [curto, longo] = ni.length <= np.length ? [ni, np] : [np, ni];
    if (curto.length >= 8 && longo.includes(curto)) return "exato";
  }
  const f = familia(procKlingo);
  return f && itens.some((it) => familia(it) === f) ? "familia" : null;
}

// Prontuário JÁ CONFERIDO (CPF + nascimento conferidos no chat, ou vínculo confirmado pela equipe) é a identidade mais forte: a marcação do
// Klingo com esse prontuário é da pessoa mesmo que o nome ou o telefone digitados no chat estivessem errados (ou tenham sido corrigidos só no Klingo).
// Primeiro tenta SÓ as marcações desse prontuário (homônimos pelo nome são ignorados); se elas não servem para este pedido (nenhuma depois da conversa
// com o exame certo), volta à regra de sempre, que olha nome completo e telefone em todas as marcações abertas.
function avaliar(alvo: Alvo, linhas: Row[], porProntuario: boolean): Resultado {
  const nome = normNome(alvo.nome);
  const nomeCompleto = nome.split(" ").length >= 2;
  const minEm = Date.parse(alvo.conv_criada) - 3_600_000;   // marcação feita antes da conversa (menos 1 h) não é agendamento deste pedido
  const cadastros = new Set<string>();
  const cands: Array<Marcacao & { ident: Identidade }> = [];
  let fracos = 0, outros = 0;
  for (const l of linhas) {
    const nomeL = normNome(l.col15);
    const nomeIgual = nomeCompleto && nomeL === nome;
    const foneIgual = [...fonesDaLinha(l.col16), ...fonesDaLinha(l.col17)].some((f) => alvo.fones.includes(f));
    if (!porProntuario && !nomeIgual) { if (foneIgual && nomeConfere(l.col15, alvo.nome)) fracos++; continue; }
    const pront = txt(l.col2, 40) || "sem-prontuario";
    cadastros.add(pront);
    const em = txt(l.col3, 30), para = txt(l.col4, 30), proc = txt(l.col5, 200);
    if (!/^\d{4}-\d{2}-\d{2}/.test(para) || !/^\d{4}-\d{2}-\d{2}/.test(em) || paraMs(em) < minEm) continue;
    const c = compat(proc, alvo.itens);
    if (!c) { outros++; continue; }
    cands.push({ id: txt(l.col0, 40), proc, unidade: txt(l.col14, 120), para, em, compat: c, ident: porProntuario || foneIgual ? "forte" : "medio" });
  }
  const exatos = cands.filter((c) => c.compat === "exato");
  const escolhidas = exatos.length ? exatos : cands.length === 1 ? cands : [];
  const ambiguo = cadastros.size > 1 || (exatos.length === 0 && cands.length > 1);
  const ident: Identidade | null = escolhidas.length ? (escolhidas.some((c) => c.ident === "forte") ? "forte" : "medio") : null;
  return {
    id: alvo.id, identidade: ambiguo ? null : ident, ambiguo, cadastros: cadastros.size, fracos, outros_exames: outros, por_prontuario: porProntuario && !ambiguo && escolhidas.length > 0,
    marcacoes: ambiguo ? [] : escolhidas.map(({ ident: _i, ...m }) => m).sort((a, b) => a.para.localeCompare(b.para)),
  };
}

export function casar(alvo: Alvo, linhas: Row[]): Resultado {
  const abertas = linhas.filter((l) => normNome(l.col12) === "ABERTA");
  const pronts = new Set((alvo.prontuarios ?? []).map((p) => txt(p, 40)).filter(Boolean));
  const doProntuario = pronts.size ? abertas.filter((l) => pronts.has(txt(l.col2, 40))) : [];
  if (doProntuario.length) {
    const r = avaliar(alvo, doProntuario, true);
    if (r.marcacoes.length > 0 || r.ambiguo) return r;
  }
  return avaliar(alvo, abertas, false);
}
