// Regras puras (sem Deno, testáveis) do motor de busca de vagas da solicitação de disponibilidade futura.
// FLUXO: entrada (período de interesse da solicitação) -> validação (datas ISO, período no futuro) -> processamento (janelas de no máximo 15 dias, o limite da API) -> saída (lista de janelas)
// Versão 1.0 — 14/11/2026 / Mudança: primeira versão.
import { somaDias } from "./oferta.ts";

export type Janela = { inicio: string; fim: string };
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Divide [de, ate] em janelas de até 15 dias (a API recusa mais que isso), no máximo `max` janelas por rodada (cota da API). Período inválido ou já passado = nenhuma janela. */
export function janelasDoPeriodo(hoje: string, de: string, ate: string, max = 3): Janela[] {
  if (![hoje, de, ate].every((d) => ISO.test(d))) return [];
  const inicioReal = de > hoje ? de : hoje;
  if (ate < inicioReal) return [];
  const saida: Janela[] = [];
  let ini = inicioReal;
  while (ini <= ate && saida.length < max) {
    const fimJanela = somaDias(ini, 14);
    saida.push({ inicio: ini, fim: fimJanela < ate ? fimJanela : ate });
    ini = somaDias(fimJanela, 1);
  }
  return saida;
}
