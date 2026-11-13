// FLUXOGRAMA: entrada (linhas do relatório #14554 do Klingo: marcações pela data em que foram marcadas) -> validação (id numérico e data de marcação válida; o resto é opcional) -> lógica (CPF, e-mail e telefone viram marca SHA-256 de dado + segredo da clínica; nascimento só como data; campo vazio vira só o nome do campo) -> saída (linhas enxutas {m,em,para,o,s,u,pl,n,fh,fh2,nasc,cpfh,emh,vz} para `klingo_conferir_lote`)
// Versão 1.0 — 13/11/2026 / Mudança: Implementação inicial (conferência Klingo x webchat)
//
// Tudo aqui é função pura (sem rede, sem banco), para testar sem Klingo. As linhas trazem CPF, telefone, e-mail e nascimento de pacientes:
// ficam só na memória da Edge Function. O que sai daqui são marcas (hash) que o banco compara com o chat e descarta; nada disso é gravado em claro.
//
// Colunas do relatório #14554 (conferidas em 13/11/2026): col0 Id da Marcação, col1 Agendado Em (data da marcação), col2 Agendado Para (data do exame), col3 Origem,
// col4 Portal, col5 Responsável, col6 Responsável - Classificação, col7 Procedimento, col8 Operadora, col9 Unidade, col10 Paciente - Nome, col11 Status (Aberta/Cancelada/Bloqueada),
// col12 CPF, col13 Telefone, col14 e-mail, col15 Nascimento, col16 Celular.

export type Row = Record<string, unknown>;
export type LinhaConf = { m: string; em: string; para: string; o: string; s: string; u: string; pl: string; n: string; fh: string; fh2: string; nasc: string; cpfh: string; emh: string; vz: string[] };

const ISO = /^\d{4}-\d{2}-\d{2}/;
export const txt = (v: unknown, max = 200): string => String(v ?? "").trim().slice(0, max);
export const digitos = (v: unknown): string => String(v ?? "").replace(/\D/g, "");

export const somaDias = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const hojeBrasilia = (agora: Date = new Date()): string => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(agora);

const sha256Hex = async (texto: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Mesma conta de public.jornada_conversa_do_card e do `fh` do painel: SHA-256 hex de (8 últimos dígitos + segredo). Menos de 8 dígitos: sem marca.
export async function hashFone(v: unknown, sal: string): Promise<string> {
  const d = digitos(v);
  return d.length < 8 ? "" : sha256Hex(d.slice(-8) + sal);
}
// SHA-256 hex de (11 dígitos do CPF + segredo). Qualquer outro tamanho: sem marca (e conta como "CPF vazio").
export async function hashCpf(v: unknown, sal: string): Promise<string> {
  const d = digitos(v);
  return d.length === 11 ? sha256Hex(d + sal) : "";
}
// SHA-256 hex de (e-mail em minúsculas + segredo). Sem "@": sem marca.
export async function hashEmail(v: unknown, sal: string): Promise<string> {
  const e = txt(v, 200).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? sha256Hex(e + sal) : "";
}

export const dataIso = (v: unknown): string => { const t = txt(v, 40); return ISO.test(t) ? t.slice(0, 10) : ""; };

// Uma linha do relatório -> uma linha enxuta para o banco. null = sem id numérico ou sem data de marcação (não serve).
export async function mapearLinha(r: Row, sal: string): Promise<LinhaConf | null> {
  const m = txt(r.col0, 20), em = dataIso(r.col1);
  if (!/^\d{1,12}$/.test(m) || !em) return null;
  const fh = await hashFone(r.col16, sal), fh2 = await hashFone(r.col13, sal), cpfh = await hashCpf(r.col12, sal), emh = await hashEmail(r.col14, sal);
  const vz: string[] = [];
  if (!cpfh) vz.push("cpf");
  if (!emh) vz.push("email");
  if (!fh && !fh2) vz.push("celular");
  return { m, em, para: dataIso(r.col2), o: txt(r.col3, 40), s: txt(r.col11, 20), u: txt(r.col9, 120), pl: txt(r.col8, 120), n: txt(r.col10, 120), fh, fh2, nasc: dataIso(r.col15), cpfh, emh, vz };
}

export async function prepararLinhas(linhas: Row[], sal: string): Promise<{ linhas: LinhaConf[]; descartadas: number }> {
  const porId = new Map<string, LinhaConf>();
  let descartadas = 0;
  for (const r of linhas) {
    const l = await mapearLinha(r, sal);
    if (!l) { descartadas++; continue; }
    porId.set(l.m, l);
  }
  return { linhas: [...porId.values()], descartadas };
}

export function emLotes<T>(itens: T[], tamanho: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) out.push(itens.slice(i, i + tamanho));
  return out;
}

// Janela de leitura: "dias" para trás contando hoje (1 a 31), ou de/até explícitos.
export function janelaLeitura(corpo: { dias?: unknown; de?: unknown; ate?: unknown }, hoje: string): { de: string; ate: string } {
  const de = String(corpo?.de ?? ""), ate = String(corpo?.ate ?? "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(de) && /^\d{4}-\d{2}-\d{2}$/.test(ate) && de <= ate && ate <= hoje) return { de, ate };
  const dias = Math.min(Math.max(Number.parseInt(String(corpo?.dias ?? "4"), 10) || 4, 1), 31);
  return { de: somaDias(hoje, -(dias - 1)), ate: hoje };
}
