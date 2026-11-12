// Regras puras (sem Deno, testáveis) do chat-agenda-api: que pedido fazer à API e como guardar o que ela devolveu.
// Versão 1.0 — 12/11/2026.
import type { Horario } from "./klingo-api.ts";

export type Esp = { cbos: string; procedimentos: number[] };
export type DadosConversa = {
  tipo: string | null; plano: string | null; procedimento: number | null; n_procedimentos: number;
  cpf: string | null; nascimento: string | null; sexo: string | null;
  identidade: { situacao: string; klingo_id: string | null; plano_id: number | null } | null;
};
export type Oferta = { chave: string; data: string; hora: string; profissional: string | null; profissional_id: string | null; unidade: string | null; unidade_id: string | null; ordem_chegada: boolean; procedimento: number | null };

/** O que perguntar à API: consulta = CBOS da especialidade; exame = id do procedimento. Nulo = esta conversa não é para a API (vários exames, sem procedimento, consulta de especialidade que a API não oferece). */
export function pedidoDaApi(d: DadosConversa, especialidades: Esp[]): { especialidade?: string; exame?: string } | null {
  if (d.n_procedimentos !== 1 || !d.procedimento) return null;
  if (d.tipo === "consulta") {
    const e = especialidades.find((x) => x.procedimentos.includes(d.procedimento!));
    return e ? { especialidade: e.cbos } : null;
  }
  if (d.tipo === "exame") return { exame: String(d.procedimento) };
  return null;
}

/** Só a oferta do procedimento certo: na consulta a API devolve vários procedimentos da especialidade (ex.: 1096 e 1472); guardamos o de cada horário (é ele que vai na marcação). */
export function montarOfertas(hs: Horario[], limite = 600): Oferta[] {
  const vistos = new Set<string>();
  const saida: Oferta[] = [];
  for (const h of hs) {
    if (!h.id || vistos.has(h.id) || !/^\d{4}-\d{2}-\d{2}$/.test(h.data) || !/^\d{2}:\d{2}$/.test(h.hora)) continue;
    vistos.add(h.id);
    const proc = Number(h.procedimento);
    saida.push({ chave: h.id, data: h.data, hora: h.hora, profissional: h.profissional?.nome ?? null, profissional_id: h.profissional?.id ?? null,
      unidade: h.unidade?.nome ?? h.unidade?.sigla ?? null, unidade_id: h.unidade?.id ?? null, ordem_chegada: h.ordem_chegada, procedimento: Number.isInteger(proc) && proc > 0 ? proc : null });
    if (saida.length >= limite) break;
  }
  return saida;
}

export const hojeBahia = (agora = new Date()) => agora.toLocaleString("sv-SE", { timeZone: "America/Bahia" }).slice(0, 10);
export const somaDias = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
