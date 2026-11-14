// Regras puras (sem Deno, testáveis) do chat-agenda-api: que pedido fazer à API, como diagnosticar o que ela devolveu e como guardar.
// FLUXO: entrada (dados da conversa; resposta CRUA da API) -> validação (estrutura, formato, data/hora no futuro) -> processamento (diagnóstico por etapa) -> persistência (quem chama grava klingo_consulta e klingo_oferta) -> saída (resultado + ofertas)
// Versão 1.0 — 12/11/2026.
// Versão 2.0 — 14/11/2026 / Mudança: diagnosticar() separa "a API respondeu sem horários" de "respondeu com horários e todos foram descartados" e de "estrutura inesperada"; HTTP 200 NÃO prova que existem horários.
import { normalizarHorarios, type Horario } from "./klingo-api.ts";

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

export type ResultadoDiagnostico = "ok_com_horarios" | "api_sem_horarios" | "todos_filtrados" | "estrutura_invalida";
export type Diagnostico = { resultado: ResultadoDiagnostico; recebidos: number; validos: number; filtrados: number; ofertas: Oferta[] };

/** Quantos horários a API mandou (sem interpretar). Nulo = a resposta não tem a forma esperada ({ horarios: [ { data, horarios: [...] | {...} } ] }). */
export function contarBrutos(resposta: unknown): number | null {
  const dias = (resposta as { horarios?: unknown } | null | undefined)?.horarios;
  if (!Array.isArray(dias)) return null;
  let n = 0;
  for (const dia of dias) {
    const lista = (dia as { horarios?: unknown } | null)?.horarios;
    if (Array.isArray(lista)) n += lista.length;
    else if (lista && typeof lista === "object") n += Object.keys(lista as object).length;
  }
  return n;
}

/**
 * Etapas: (1) a resposta tem a forma esperada? (2) quantos horários vieram? (3) quantos têm id, data e hora válidos? (4) quantos ainda estão no futuro?
 * Só "ok_com_horarios" autoriza mostrar horário ao paciente. Nenhum dado pessoal passa por aqui.
 */
export function diagnosticar(resposta: unknown, hoje: string, horaAgora: string, limite = 600): Diagnostico {
  const recebidos = contarBrutos(resposta);
  if (recebidos === null) return { resultado: "estrutura_invalida", recebidos: 0, validos: 0, filtrados: 0, ofertas: [] };
  const validos = montarOfertas(normalizarHorarios(resposta), limite);
  const ofertas = validos.filter((o) => o.data > hoje || (o.data === hoje && o.hora > horaAgora));
  const resultado: ResultadoDiagnostico = recebidos === 0 ? "api_sem_horarios" : ofertas.length === 0 ? "todos_filtrados" : "ok_com_horarios";
  return { resultado, recebidos, validos: validos.length, filtrados: Math.max(recebidos - ofertas.length, 0), ofertas };
}

/** O que a tela precisa saber (o banco recalcula do mesmo registro; isto é só a resposta imediata). */
export function estadoDoResultado(r: string): "com_horarios" | "sem_horarios" | "indisponivel" | "nao_integrado" {
  if (r === "ok_com_horarios") return "com_horarios";
  if (r === "api_sem_horarios" || r === "todos_filtrados") return "sem_horarios";
  if (r === "estrutura_invalida" || r === "erro_api" || r === "limite" || r === "erro_gravacao") return "indisponivel";
  return "nao_integrado";
}

/** Motivo interno (o texto que a equipe lê em klingo_horarios_falha) -> resultado de klingo_consulta. */
export function resultadoDoMotivo(m: string): string {
  if (m === "limite") return "limite";
  if (m === "indisponivel" || m === "sem_chave") return "erro_api";
  if (m === "fora_do_escopo" || m === "dados_incompletos" || m === "sem_pedido") return m;
  if (m === "regra_paciente") return "fora_do_escopo";   // v2.1: idade/sexo do paciente não vale para o procedimento
  return "sem_traducao_plano";   // sem_traducao, plano_inativo, plano_desconhecido, sem_medico, plano_do_cadastro_necessario...
}

export const hojeBahia = (agora = new Date()) => agora.toLocaleString("sv-SE", { timeZone: "America/Bahia" }).slice(0, 10);
export const horaBahia = (agora = new Date()) => agora.toLocaleString("sv-SE", { timeZone: "America/Bahia" }).slice(11, 16);
export const somaDias = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
