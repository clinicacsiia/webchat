// FLUXOGRAMA: entrada (id de um exame do chat + a data de hoje + o cliente da API do Klingo) -> validação (só pergunta o que a API já aceita: janelas de 15 dias, sexo e nascimento de mentira)
//   -> lógica (olha 3 janelas seguidas, 45 dias no total, o mesmo alcance do calendário do chat; para na primeira que tiver horário; só diz "sem horário" se TODAS as janelas foram respondidas pelo Klingo)
//   -> saída ({tipo:"tem", primeiro} | {tipo:"vazio"} | {tipo:"pular", motivo} | {tipo:"limite"}); nenhum dado de paciente entra nem sai
// Versão 1.0 — 15/11/2026 / Mudança: separado do index.ts para testar sem o Klingo; passa de 14 para 45 dias (um exame com agenda só aos sábados, fora dos próximos 14 dias, deixava de aparecer por engano).
import { KlingoErro } from "./klingo-api.ts";
import type { Horario, PedidoHorarios } from "./klingo-api.ts";

export const DIAS_POR_JANELA = 15;   // o Klingo recusa períodos maiores que 15 dias (403 "Período excedido. Máximo 15 dias.")
export const JANELAS = 3;            // 3 x 15 = 45 dias, igual ao calendário do chat (chat_horarios)

export type Resultado =
  | { tipo: "tem"; primeiro: string | null }
  | { tipo: "vazio" }
  | { tipo: "pular"; motivo: string }
  | { tipo: "limite" };

export type ApiHorarios = { horarios(p: PedidoHorarios): Promise<Horario[]> };

const somaDias = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** [início, fim] de cada janela; a seguinte começa no dia depois do fim da anterior. */
export function janelas(hoje: string, n = JANELAS): Array<[string, string]> {
  return Array.from({ length: n }, (_, i) => [somaDias(hoje, i * DIAS_POR_JANELA), somaDias(hoje, i * DIAS_POR_JANELA + DIAS_POR_JANELA - 1)] as [string, string]);
}

const SEM_OFERTA = new Set(["sem_medico", "plano_inativo", "plano_desconhecido"]);   // o Klingo respondeu: para este exame não há quem atenda

export async function sondarExame(api: ApiHorarios, id: number, hoje: string, n = JANELAS): Promise<Resultado> {
  for (const [inicio, fim] of janelas(hoje, n)) {
    let respondidas = 0, semOferta = 0, motivo = "";
    // sem a sessão de um paciente o Klingo pede sexo e nascimento: usa um adulto de mentira; se não houver horário para um sexo, tenta o outro
    for (const sexo of ["F", "M"]) {
      try {
        const hs = await api.horarios({ exame: String(id), inicio, fim, sexo, nascimento: "1985-06-15" });
        respondidas++;
        if (hs.length > 0) return { tipo: "tem", primeiro: hs[0].data || null };
      } catch (e) {
        if (e instanceof KlingoErro && e.tipo === "limite") return { tipo: "limite" };
        if (e instanceof KlingoErro && SEM_OFERTA.has(e.tipo)) { respondidas++; semOferta++; continue; }
        motivo = e instanceof KlingoErro ? `${e.tipo}_${e.status}` : "erro";
      }
    }
    if (respondidas < 2) return { tipo: "pular", motivo: motivo || "erro" };   // alguma resposta faltou: não dá para afirmar "sem horário"
    if (semOferta === 2) return { tipo: "vazio" };                             // nenhum médico credenciado: as outras janelas dariam o mesmo
  }
  return { tipo: "vazio" };
}
