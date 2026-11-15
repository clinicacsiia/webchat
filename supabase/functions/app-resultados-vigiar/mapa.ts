// Funções puras (sem rede) da vigia de resultados: quem tem laudo pronto no relatório C do Klingo, e conferência do nascimento no relatório A.
// Versão 1.0 — 15/11/2026 / Mudança: Implementação inicial. Colunas conferidas em docs/klingo-relatorios-pendentes.md (A #14024, C #14026).
export type Row = Record<string, unknown>;
export const REL = { A: "14024", C: "14026" } as const;
const txt = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

// Aceita AAAA-MM-DD, DD/MM/AAAA e qualquer um dos dois seguido de hora.
export function nascimentoIso(v: unknown): string | null {
  const t = txt(v);
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let y: string, mo: string, d: string;
  if (m) [, y, mo, d] = m;
  else if ((m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})/))) [, d, mo, y] = m;
  else return null;
  const dt = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null;
  return `${y}-${mo}-${d}`;
}
export function prontuarioValido(v: unknown): string | null {
  const t = txt(v);
  return /^[0-9A-Za-z-]{1,20}$/.test(t) ? t : null;
}
// Relatório A: col0 prontuário, col3 nascimento. Só devolve "confere" se existe UM cadastro com esse prontuário e o nascimento é o informado.
export function nascimentoConfere(linhas: Row[], prontuario: string, nascimento: string): boolean {
  const alvo = linhas.filter((r) => txt(r.col0) === prontuario);
  return alvo.length === 1 && nascimentoIso(alvo[0].col3) === nascimento;
}
// Relatório C: col0 Id do atendimento, col6 data em que o laudo ficou pronto, col7 Id do laudo. Laudo pronto = uma das duas colunas preenchida.
export function laudosProntos(linhas: Row[]): Set<string> {
  const s = new Set<string>();
  for (const r of linhas) if (txt(r.col0) && (nascimentoIso(r.col6) || txt(r.col7))) s.add(txt(r.col0));
  return s;
}
export function hojeBrasilia(agora = new Date()): string {
  return new Date(agora.getTime() - 3 * 3600_000).toISOString().slice(0, 10);
}
export function janela(meses: number, hoje: string): { de: string; ate: string } {
  const d = new Date(`${hoje}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - meses);
  d.setUTCDate(d.getUTCDate() + 1);
  return { de: d.toISOString().slice(0, 10), ate: hoje };
}
export type Alvo = { id: string; atendimento: string; prontuario: string; nascimento: string };
// Um prontuário (com o mesmo nascimento) = uma única consulta ao Klingo.
export function agrupar(alvos: Alvo[]): Map<string, Alvo[]> {
  const m = new Map<string, Alvo[]>();
  for (const a of alvos) {
    const p = prontuarioValido(a.prontuario), n = nascimentoIso(a.nascimento);
    if (!p || !n || !a.atendimento || !a.id) continue;
    const k = `${p}|${n}`;
    m.set(k, [...(m.get(k) ?? []), { ...a, prontuario: p, nascimento: n }]);
  }
  return m;
}
