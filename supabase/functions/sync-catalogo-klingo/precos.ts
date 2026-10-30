// Preço lançado no Klingo (relatório #7, coluna Previsto), agregado por exame e operadora.
// Das linhas do relatório só saem Procedimento, Operadora, Previsto e Quantidade: nome, telefone e prontuário nem são lidos aqui.
// A saída é só agregado (valor mais frequente, mínimo, máximo, amostras): serve para conferir o catalogo_preco.

export type Row = Record<string, unknown>;
export type PrecoObservado = {
  procedimento: string; operadora: string; valor_tipico: number; valor_min: number; valor_max: number; amostras: number; ini: string; fim: string;
};

// Aceita número, "250", "250.5", "250,50", "1.250,50" e "R$ 1.250,50". Devolve null se não for um valor em reais plausível.
export function valorEmReais(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 && v < 100_000 ? Math.round(v * 100) / 100 : null;
  let t = String(v ?? "").replace(/R\$|\s/gi, "");
  if (!/^\d[\d.,]*$/.test(t)) return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");   // "1.250" = mil duzentos e cinquenta
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n < 100_000 ? Math.round(n * 100) / 100 : null;
}

const chave = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();

// Linhas com quantidade maior que 1 são ignoradas: não dá para saber se o Previsto é o valor unitário ou o total.
export function agregarPrecos(linhas: Row[], ini: string, fim: string): PrecoObservado[] {
  const grupos = new Map<string, { procedimento: string; operadora: string; valores: Map<number, number> }>();
  for (const r of linhas) {
    const procedimento = String(r.Procedimento ?? "").trim(), operadora = String(r.Operadora ?? "").trim();
    const valor = valorEmReais(r.Previsto);
    const qtd = Number(r.Quantidade ?? 1);
    if (!procedimento || !operadora || valor === null || (Number.isFinite(qtd) && qtd > 1)) continue;
    const k = `${chave(procedimento)}|${chave(operadora)}`;
    if (k.startsWith("|") || k.endsWith("|")) continue;
    const g = grupos.get(k) ?? { procedimento, operadora, valores: new Map<number, number>() };
    g.valores.set(valor, (g.valores.get(valor) ?? 0) + 1);
    grupos.set(k, g);
  }
  return [...grupos.values()].map((g) => {
    const vals = [...g.valores.entries()];
    const amostras = vals.reduce((s, [, n]) => s + n, 0);
    // o valor mais repetido; empate fica com o menor, para o resultado não depender da ordem das linhas
    const tipico = vals.sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    const todos = vals.map(([x]) => x);
    return { procedimento: g.procedimento, operadora: g.operadora, valor_tipico: tipico, valor_min: Math.min(...todos), valor_max: Math.max(...todos), amostras, ini, fim };
  });
}
