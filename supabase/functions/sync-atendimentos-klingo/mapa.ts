// FLUXOGRAMA: entrada (linhas do relatório #14637 do Klingo: Data do Atendimento, Primeira Vez, Nome, Profissional, CPF, Prontuário, Nascimento) -> validação (colunas pelo TÍTULO; CPF de 11 dígitos, nascimento e data de atendimento válidos, profissional preenchido) -> lógica (cada linha vira {c: cpf, n: nascimento, p: prontuário, q: profissional, d: data}; faixas de até 14 dias) -> saída (lotes para consulta_atendida_lote, que guarda só o hash de CPF+nascimento)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial (regra "primeira consulta só com atendente"). Funções puras: sem rede, sem banco. As linhas têm CPF e nome de pacientes: ficam só na memória; o nome NUNCA é lido aqui.

export type Row = Record<string, unknown>;
export type Coluna = { name?: unknown; title?: unknown };
export type Atendimento = { c: string; n: string; p: string; q: string; d: string };

export const TITULOS: Record<string, string> = { data: "Data do Atendimento", prof: "Profissional", cpf: "Paciente - CPF", nasc: "Paciente - Nascimento", pront: "Paciente - Prontuario", primeira: "Primeira Vez" };
const OBRIGATORIOS = ["data", "prof", "cpf", "nasc"];   // sem prontuário ainda dá para casar pelo CPF + nascimento

const normTitulo = (v: unknown): string => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const numero = (n: unknown): number => { const m = /^col(\d+)$/.exec(String(n ?? "").trim()); return m ? Number(m[1]) : Number.NaN; };

// Acha cada coluna pelo título (a de menor número se repetir). Título obrigatório ausente = a leitura para e diz qual.
export function acharColunas(colunas: Coluna[]): { cols: Record<string, string>; faltando: string[] } {
  const validas = colunas.map((c) => ({ n: numero(c?.name), nome: String(c?.name ?? "").trim(), t: normTitulo(c?.title) })).filter((c) => Number.isFinite(c.n) && c.t).sort((a, b) => a.n - b.n);
  const cols: Record<string, string> = {}, faltando: string[] = [];
  for (const [campo, titulo] of Object.entries(TITULOS)) {
    const achada = validas.find((c) => c.t === normTitulo(titulo))?.nome;
    if (achada) cols[campo] = achada; else if (OBRIGATORIOS.includes(campo)) faltando.push(titulo);
  }
  return { cols, faltando };
}

const txt = (v: unknown, max: number): string => String(v ?? "").trim().slice(0, max);
// "2026-11-02", "2026-11-02 08:00:00" ou "02/11/2026" -> "2026-11-02"; qualquer outra coisa = "".
export function lerData(v: unknown): string {
  const t = String(v ?? "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (!m) { const b = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(t); if (b) m = [b[0], b[3], b[2], b[1]] as unknown as RegExpExecArray; }
  if (!m) return "";
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return d.getUTCFullYear() === ano && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

// Linhas do relatório -> atendimentos prontos para o banco. Descarta CPF que não tem 11 dígitos, sem nascimento, sem data ou sem profissional (só conta; nunca guarda o motivo com dado).
export function mapear(linhas: Row[], cols: Record<string, string>): { itens: Atendimento[]; descartadas: number } {
  const itens: Atendimento[] = []; let descartadas = 0;
  for (const r of linhas) {
    const c = String(r[cols.cpf] ?? "").replace(/\D/g, ""), n = lerData(r[cols.nasc]), d = lerData(r[cols.data]), q = txt(r[cols.prof], 120);
    if (c.length !== 11 || !n || !d || !q) { descartadas++; continue; }
    itens.push({ c, n, p: cols.pront ? txt(r[cols.pront], 40) : "", q, d });
  }
  return { itens, descartadas };
}

export const somaDias = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const hojeBrasilia = (agora: Date = new Date()): string => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(agora);
export const dataOk = (v: unknown): v is string => typeof v === "string" && lerData(v) === v && /^\d{4}-\d{2}-\d{2}$/.test(v);

// Divide [de, ate] em faixas de no máximo `dias` dias (o Klingo recusa períodos longos e corta respostas grandes).
export function faixas(de: string, ate: string, dias = 14): [string, string][] {
  const out: [string, string][] = [];
  for (let ini = de; ini <= ate; ini = somaDias(ini, dias)) { const fim = somaDias(ini, dias - 1); out.push([ini, fim < ate ? fim : ate]); }
  return out;
}
export function emLotes<T>(itens: T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) lotes.push(itens.slice(i, i + tamanho));
  return lotes;
}
