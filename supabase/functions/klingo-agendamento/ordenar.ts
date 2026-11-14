// Como mostrar os médicos e os horários para quem quer marcar: ordem pensada na pessoa, e combinações para marcar a família junta.
// Versão 1.0 — 13/11/2026. Sem Deno, sem rede: recebe a lista do Klingo, o histórico da família e a procura geral, e devolve a lista pronta.
//
// ORDEM DOS MÉDICOS (decisão do dono, 13/11/2026: "ordenar conforme o paciente marcou; se nunca marcou, pelos outros"):
//   1º  quem a família JÁ consultou (mais vezes primeiro) — marca "Você já foi";
//   2º  quem os OUTROS mais marcam nos últimos 90 dias (agenda_ocupacao, que vem dos relatórios #7 e #47 e não tem dado de paciente) — marca "Mais procurado" nos 3 primeiros;
//   3º  o resto, pelo primeiro horário livre (e, em empate, pelo nome).
// Todos os médicos aparecem; a ordem só decide quem vem primeiro. A UNIDADE nunca é pergunta: vem do médico e só aparece como informação.
import type { Horario } from "./api.ts";

export type Contagem = Array<{ profissional: string; total: number }>;
export type Slot = { id: string; data: string; hora: string; medico: string | null; unidade: string | null; unidade_sigla: string | null; ordem_chegada: boolean; procedimento: string | null };
export type Medico = {
  chave: string; nome: string; unidade: string | null; unidade_sigla: string | null; motivo: "ja_foi" | "mais_procurado" | null; vezes: number; procura: number;
  total: number; primeiro: string; proximos: Slot[]; todos: Slot[];
};
export type Combinacao = { tipo: "mesmo_medico" | "mesmo_dia"; itens: Slot[]; data: string; inicio: string; fim: string };

/** Nome sem acento, sem pontuação e em maiúsculas: "Dra. Sílvia  Lima" -> "DRA SILVIA LIMA". */
export const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const TRATAMENTO = new Set(["DR", "DRA", "PROF", "PROFA"]);
const palavras = (s: string) => norm(s).split(" ").filter((p) => p && !TRATAMENTO.has(p));
/** O mesmo médico com nomes um pouco diferentes entre o relatório e a API ("DRA MARIA LIMA" x "MARIA A LIMA"): vale se todas as palavras do nome menor estão no maior (mínimo 2). */
export function mesmoMedico(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = palavras(String(a ?? "")), y = palavras(String(b ?? ""));
  if (!x.length || !y.length) return false;
  if (x.join(" ") === y.join(" ")) return true;
  const [menor, maior] = x.length <= y.length ? [x, y] : [y, x];
  return menor.length >= 2 && menor.every((p) => maior.includes(p));
}
const somaPara = (lista: Contagem, nome: string) => lista.reduce((n, x) => n + (mesmoMedico(x.profissional, nome) ? Number(x.total) || 0 : 0), 0);

export const slotLeve = (h: Horario): Slot => ({ id: h.id, data: h.data, hora: h.hora, medico: h.profissional?.nome ?? null, unidade: h.unidade?.nome ?? null, unidade_sigla: h.unidade?.sigla ?? null, ordem_chegada: h.ordem_chegada, procedimento: h.procedimento });
const quando = (s: Slot) => `${s.data} ${s.hora}`;

/** Agrupa os horários por médico (e unidade) e ordena pela regra acima. `todos` guarda tudo (para combinar a família); `proximos` são os 6 primeiros para a tela. */
export function ordenarMedicos(lista: Horario[], historico: Contagem, procura: Contagem, quantosProximos = 6): Medico[] {
  const grupos = new Map<string, Slot[]>();
  for (const h of lista) {
    const k = `${h.profissional?.id ?? norm(h.profissional?.nome)}|${h.unidade?.id ?? ""}`;
    (grupos.get(k) ?? grupos.set(k, []).get(k)!).push(slotLeve(h));
  }
  const cartoes: Medico[] = [...grupos].map(([chave, todos]) => {
    todos.sort((a, b) => quando(a).localeCompare(quando(b)));
    const nome = todos[0].medico ?? "Equipe da clínica";
    return { chave, nome, unidade: todos[0].unidade, unidade_sigla: todos[0].unidade_sigla, motivo: null, vezes: somaPara(historico, nome), procura: somaPara(procura, nome), total: todos.length, primeiro: quando(todos[0]), proximos: todos.slice(0, quantosProximos), todos };
  });
  cartoes.sort((a, b) => (b.vezes > 0 ? 1 : 0) - (a.vezes > 0 ? 1 : 0) || b.vezes - a.vezes || b.procura - a.procura || a.primeiro.localeCompare(b.primeiro) || a.nome.localeCompare(b.nome));
  let mais = 0;
  for (const c of cartoes) {
    if (c.vezes > 0) c.motivo = "ja_foi";
    else if (c.procura > 0 && mais < 3) { c.motivo = "mais_procurado"; mais++; }
  }
  return cartoes;
}

/** O primeiro horário livre de todos os médicos (a escolha de quem tem pressa). */
export function primeiroLivre(medicos: Medico[]): Slot | null {
  let melhor: Slot | null = null;
  for (const m of medicos) { const s = m.todos[0]; if (s && (!melhor || quando(s) < quando(melhor))) melhor = s; }
  return melhor;
}

const minutos = (hora: string) => Number(hora.slice(0, 2)) * 60 + Number(hora.slice(3, 5));

/**
 * Combinações para marcar `k` pessoas juntas (tudo ou nada). Primeiro, k horários SEGUIDOS no mesmo médico e no mesmo dia (a mãe fica com um médico só);
 * depois, k horários no mesmo dia e na mesma unidade dentro de 90 minutos (médicos diferentes). Devolve até `max` opções, em dias diferentes quando der.
 */
export function combinar(medicos: Medico[], k: number, max = 3): Combinacao[] {
  if (k < 2) return [];
  const saida: Combinacao[] = [];
  for (const m of medicos) {
    const porDia = new Map<string, Slot[]>();
    for (const s of m.todos) (porDia.get(s.data) ?? porDia.set(s.data, []).get(s.data)!).push(s);
    for (const [data, dia] of porDia) {
      if (m.todos[0].ordem_chegada) continue;                                   // ordem de chegada não tem hora marcada: não dá para "seguir"
      for (let i = 0; i + k <= dia.length; i++) {
        const itens = dia.slice(i, i + k);
        if (minutos(itens[k - 1].hora) - minutos(itens[0].hora) <= 40 * (k - 1)) { saida.push({ tipo: "mesmo_medico", itens, data, inicio: itens[0].hora, fim: itens[k - 1].hora }); break; }
      }
    }
  }
  if (saida.length < max) {
    const porDiaUnidade = new Map<string, Slot[]>();
    for (const m of medicos) for (const s of m.todos) if (!s.ordem_chegada) { const k2 = `${s.data}|${s.unidade ?? ""}`; (porDiaUnidade.get(k2) ?? porDiaUnidade.set(k2, []).get(k2)!).push(s); }
    for (const [chave, dia] of porDiaUnidade) {
      dia.sort((a, b) => a.hora.localeCompare(b.hora) || a.id.localeCompare(b.id));
      for (let i = 0; i + k <= dia.length; i++) {
        const itens = dia.slice(i, i + k);
        if (minutos(itens[k - 1].hora) - minutos(itens[0].hora) <= 90) { saida.push({ tipo: "mesmo_dia", itens, data: chave.split("|")[0], inicio: itens[0].hora, fim: itens[k - 1].hora }); break; }
      }
    }
  }
  // uma opção de cada tipo por dia, as do mesmo médico antes, depois a data mais próxima
  saida.sort((a, b) => (a.tipo === b.tipo ? 0 : a.tipo === "mesmo_medico" ? -1 : 1) || (a.data + a.inicio).localeCompare(b.data + b.inicio));
  const vistos = new Set<string>(), escolhidas: Combinacao[] = [];
  for (const c of saida) { if (vistos.has(c.data) && escolhidas.length < max && saida.some((o) => !vistos.has(o.data))) continue; vistos.add(c.data); escolhidas.push(c); if (escolhidas.length >= max) break; }
  return escolhidas.sort((a, b) => (a.data + a.inicio).localeCompare(b.data + b.inicio));
}

/** A tela só precisa do essencial: tira `todos` (que pode ser enorme). */
export const paraTela = (m: Medico) => { const { todos: _t, ...resto } = m; return resto; };
