// Funções puras da klingo-preco (testadas em preco.test.ts, sem rede).
// A API devolve {id_item_tabela, valor}. Valor ausente, não numérico, zero ou negativo = "sem preço" (nunca inventamos valor).
export function lerValor(corpo: unknown): number | null {
  const v = (corpo as { valor?: unknown } | null)?.valor;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+([.,]\d+)?$/.test(v.trim()) ? Number(v.trim().replace(",", ".")) : NaN;
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
}
export function limparIds(ids: unknown, max = 20): number[] {
  if (!Array.isArray(ids)) return [];
  const vistos = new Set<number>();
  for (const x of ids) { const n = Number(x); if (Number.isInteger(n) && n > 0 && n < 1e9) vistos.add(n); if (vistos.size >= max) break; }
  return [...vistos];
}
