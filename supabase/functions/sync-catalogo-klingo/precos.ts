// Preço lançado no Klingo (relatório #7, coluna Previsto), agregado por exame e operadora.
// Das linhas do relatório só saem Procedimento, Operadora, Previsto, Quantidade e Status: nome, telefone e prontuário nem são lidos aqui.
// A saída é só agregado (valor mais frequente, mínimo, máximo, amostras): serve para conferir o catalogo_preco.

import type { Row } from "./conferencia.ts";

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

// Igual à public.norm_chave do banco: sem acento, maiúsculas, MANTÉM os números ("2 INCIDENCIAS" e "3 INCIDENCIAS" são exames e preços diferentes).
const chave = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// Agrega aos poucos (uma linha por vez), sem guardar as linhas do relatório: só o contador de cada valor por exame e operadora.
// Linhas com quantidade maior que 1 são ignoradas: não dá para saber se o Previsto é o valor unitário ou o total.
export class AgregadorPrecos {
  private grupos = new Map<string, { procedimento: string; operadora: string; valores: Map<number, number> }>();

  add(r: Row): void {
    const procedimento = String(r.Procedimento ?? "").trim(), operadora = String(r.Operadora ?? "").trim();
    const valor = valorEmReais(r.Previsto);
    const qtd = Number(r.Quantidade ?? 1);
    // O #7 não deve trazer cancelados, mas, se trouxer, a marcação cancelada não conta como preço lançado.
    if (/cancel/i.test(String(r.Status ?? ""))) return;
    if (!procedimento || !operadora || valor === null || (Number.isFinite(qtd) && qtd > 1)) return;
    const k = `${chave(procedimento)}|${chave(operadora)}`;
    if (k.startsWith("|") || k.endsWith("|")) return;
    const g = this.grupos.get(k) ?? { procedimento, operadora, valores: new Map<number, number>() };
    g.valores.set(valor, (g.valores.get(valor) ?? 0) + 1);
    this.grupos.set(k, g);
  }

  resultado(ini: string, fim: string): PrecoObservado[] {
    return [...this.grupos.values()].map((g) => {
      const vals = [...g.valores.entries()];
      const amostras = vals.reduce((s, [, n]) => s + n, 0);
      // o valor mais repetido; empate fica com o menor, para o resultado não depender da ordem das linhas
      const tipico = vals.sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
      const todos = vals.map(([x]) => x);
      return { procedimento: g.procedimento, operadora: g.operadora, valor_tipico: tipico, valor_min: Math.min(...todos), valor_max: Math.max(...todos), amostras, ini, fim };
    });
  }
}

export function agregarPrecos(linhas: Row[], ini: string, fim: string): PrecoObservado[] {
  const a = new AgregadorPrecos();
  for (const r of linhas) a.add(r);
  return a.resultado(ini, fim);
}
