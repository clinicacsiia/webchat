// FLUXOGRAMA: entrada (linhas do relatório #14359 do Klingo = marcações por data do exame; e do #14554 = marcações com CPF, e-mail e nascimento) -> validação (só marcação ABERTA; precisa de id e de uma forma de identificar a pessoa: prontuário ou nome)
//   -> lógica (a chave da pessoa é a MESMA da Jornada: prontuário, ou "n:" + hash de nome e telefone; colunas do #14359 achadas pelo título; do #14554, pela ordem já usada em klingo-conferir; CPF vira só "tem CPF")
//   -> saída (lotes enxutos para o banco: nome, celular e telefone no #14359; e-mail, nascimento e "tem CPF" no #14554. Nada vai para log nem para a resposta) | ROLLBACK: apagar a função e desligar `previsao_marcacao_modo`
// Versão 1.0 — 17/11/2026 / Mudança: primeira versão (Webchat de Previsão de marcação).
//
// Funções puras (sem rede e sem banco), para testar sem Klingo. As linhas trazem nome, telefone, e-mail, CPF e nascimento de pacientes: ficam só na memória da Edge Function e seguem
// para as tabelas fechadas `pmarc_*`. O CPF NÃO é guardado: só se o Klingo tem (11 dígitos). O valor em R$ nunca é lido.

export type Row = Record<string, unknown>;
export type Coluna = { name?: unknown; title?: unknown };
export type Layout = { m: string; nome: string; pront: string; status: string; cel: string; tel?: string; primeira?: string };
export type LinhaCadastro = { p: string; n: string; c: string; t: string; v: string };
export type LinhaEnriquecer = { m: string; c: string; t: string; e: string; d: string; k: boolean };

// Ordem fixa do #14359 (conferida em 15/11/2026): usada só se o Klingo não mandar a lista de colunas.
export const LAYOUT_FIXO: Layout = { m: "col0", nome: "col2", pront: "col4", status: "col15", cel: "col16", tel: "col14", primeira: "col20" };
const TITULOS: Record<keyof Layout, string> = {
  m: "Id da Marcação", nome: "Paciente - Nome", pront: "Prontuário", status: "Status", cel: "Paciente - Celular", tel: "Paciente - Telefone", primeira: "Primeira Vez",
};
const OPCIONAIS = new Set<string>(["tel", "primeira"]);

const txt = (v: unknown, max = 200): string => String(v ?? "").trim().slice(0, max);
export const digitos = (v: unknown): string => String(v ?? "").replace(/\D/g, "");
const ISO = /^\d{4}-\d{2}-\d{2}/;
const normTitulo = (v: unknown): string => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const numeroDaColuna = (n: unknown): number => { const m = /^col(\d+)$/.exec(String(n ?? "").trim()); return m ? Number(m[1]) : Number.NaN; };

export const somaDias = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const hojeBrasilia = (agora: Date = new Date()): string => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(agora);

const sha256Hex = async (texto: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Nome sem acento, em maiúsculas, só letras/números e espaço simples (igual ao da Jornada: a mesma pessoa dá sempre a mesma chave).
export const normNome = (v: unknown): string =>
  String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

// IGUAL a chavePaciente de sync-jornada-klingo/mapa.ts: prontuário; ou "n:" + 24 primeiras letras do SHA-256 de (nome | 8 últimos dígitos do celular, senão do telefone | segredo).
export async function chavePessoa(r: Row, L: Layout, segredo: string): Promise<string> {
  const prontuario = txt(r[L.pront], 40);
  if (prontuario) return prontuario;
  const nome = normNome(r[L.nome]);
  if (!nome) return "";
  const fone = digitos(r[L.cel]).slice(-8) || digitos(L.tel ? r[L.tel] : "").slice(-8);
  return "n:" + (await sha256Hex(`${nome}|${fone}|${segredo}`)).slice(0, 24);
}

// Colunas do #14359 pelo título. Devolve também os títulos obrigatórios que sumiram (a leitura para e diz qual, em vez de adivinhar).
export function layoutPorTitulos(colunas: Coluna[] | undefined, reserva: Layout = LAYOUT_FIXO): { layout: Layout; faltando: string[]; por: "título" | "ordem fixa" } {
  if (!colunas || !colunas.length) return { layout: reserva, faltando: [], por: "ordem fixa" };
  const validas = colunas.map((c) => ({ n: numeroDaColuna(c?.name), nome: String(c?.name ?? "").trim(), t: normTitulo(c?.title) })).filter((c) => Number.isFinite(c.n) && c.t).sort((a, b) => a.n - b.n);
  const achada = (titulo: string): string | undefined => validas.find((c) => c.t === normTitulo(titulo))?.nome;
  const layout: Record<string, string | undefined> = { ...reserva };
  const faltando: string[] = [];
  for (const campo of Object.keys(TITULOS) as (keyof Layout)[]) {
    const col = achada(TITULOS[campo]);
    if (col) layout[campo] = col;
    else if (OPCIONAIS.has(campo)) delete layout[campo];
    else faltando.push(TITULOS[campo]);
  }
  return { layout: layout as Layout, faltando, por: "título" };
}

// Só vale marcação ABERTA (cancelada e bloqueada não são previsão de ninguém).
export const marcacaoAberta = (r: Row, L: Layout): boolean => /^aberta$/i.test(txt(r[L.status], 20));

// Uma linha do #14359 -> {p, n, c, t, v}. null = fechada, sem id, ou sem como identificar a pessoa.
export async function mapearCadastro(r: Row, L: Layout, segredo: string): Promise<LinhaCadastro | null> {
  if (!marcacaoAberta(r, L) || !txt(r[L.m], 40)) return null;
  const p = await chavePessoa(r, L, segredo);
  if (!p) return null;
  return { p, n: txt(r[L.nome], 120), c: digitos(r[L.cel]).slice(-13), t: L.tel ? digitos(r[L.tel]).slice(-13) : "", v: L.primeira ? txt(r[L.primeira], 3).toUpperCase() : "" };
}

// Várias marcações da mesma pessoa viram uma linha só: fica o primeiro nome, celular e telefone que vierem; "primeira vez" vale S se qualquer uma disser S.
export async function prepararCadastro(linhas: Row[], L: Layout, segredo: string): Promise<{ linhas: LinhaCadastro[]; descartadas: number; semProntuario: number }> {
  const porPessoa = new Map<string, LinhaCadastro>();
  let descartadas = 0, semProntuario = 0;
  for (const r of linhas) {
    const l = await mapearCadastro(r, L, segredo);
    if (!l) { descartadas++; continue; }
    const antes = porPessoa.get(l.p);
    if (!antes) { porPessoa.set(l.p, l); if (l.p.startsWith("n:")) semProntuario++; continue; }
    porPessoa.set(l.p, { p: l.p, n: antes.n || l.n, c: antes.c || l.c, t: antes.t || l.t, v: antes.v === "S" || l.v === "S" ? "S" : antes.v || l.v });
  }
  return { linhas: [...porPessoa.values()], descartadas, semProntuario };
}

// #14554 (ordem conferida em 13/11/2026, a mesma de klingo-conferir): col0 Id da Marcação, col11 Status, col12 CPF, col13 Telefone, col14 e-mail, col15 Nascimento, col16 Celular.
// Sai só "tem CPF" (11 dígitos). O e-mail e o nascimento seguem para o banco, que só os aceita bem formados.
export function mapearEnriquecer(r: Row): LinhaEnriquecer | null {
  const m = txt(r.col0, 20);
  if (!/^\d{1,12}$/.test(m)) return null;
  const nasc = txt(r.col15, 40);
  return { m, c: digitos(r.col16).slice(-13), t: digitos(r.col13).slice(-13), e: txt(r.col14, 200).toLowerCase(), d: ISO.test(nasc) ? nasc.slice(0, 10) : "", k: digitos(r.col12).length === 11 };
}
export function prepararEnriquecer(linhas: Row[]): { linhas: LinhaEnriquecer[]; descartadas: number } {
  const porId = new Map<string, LinhaEnriquecer>();
  let descartadas = 0;
  for (const r of linhas) { const l = mapearEnriquecer(r); if (!l) { descartadas++; continue; } porId.set(l.m, l); }
  return { linhas: [...porId.values()], descartadas };
}

export function emLotes<T>(itens: T[], tamanho: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) out.push(itens.slice(i, i + tamanho));
  return out;
}

export type Modo = "rapido" | "completo" | "enriquecer";
export const modoValido = (v: unknown): Modo => (v === "completo" ? "completo" : v === "enriquecer" ? "enriquecer" : "rapido");

// Janela de cada relatório por modo. #14359 = data do exame (de hoje para a frente); #14554 = data em que a marcação foi FEITA (para trás, no máximo 31 dias).
export function janelas(modo: Modo, hoje: string, corpo: { de?: unknown; ate?: unknown } = {}): { exame: { de: string; ate: string } | null; feitas: { de: string; ate: string } | null } {
  if (modo === "completo") return { exame: { de: hoje, ate: somaDias(hoje, 365) }, feitas: null };
  if (modo === "rapido") return { exame: { de: hoje, ate: somaDias(hoje, 7) }, feitas: { de: somaDias(hoje, -2), ate: hoje } };
  const de = String(corpo?.de ?? ""), ate = String(corpo?.ate ?? "");
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(de) && /^\d{4}-\d{2}-\d{2}$/.test(ate) && de <= ate && ate <= hoje && Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`) <= 30 * 86_400_000;
  return { exame: null, feitas: ok ? { de, ate } : { de: somaDias(hoje, -30), ate: hoje } };
}
