// Conferência de CPF + nascimento na API do Klingo (sem Deno, para testar com dados inventados).
// Versão 1.0 — 12/11/2026.
import { KlingoApi, KlingoErro, resumoPaciente } from "./klingo-api.ts";

export type Resultado = { situacao: string; klingo_id?: string; faltando?: string[]; plano_id?: number | null; _plano_achado?: boolean; _contatos_achados?: boolean };

export async function identificar(api: KlingoApi, cpf: string, nascimento: string): Promise<Resultado> {
  try {
    const r = await api.pacientePorCpf(cpf) as Record<string, unknown> | null;
    const s = resumoPaciente(r);
    if (!s.id) return { situacao: "nao_encontrado" };
    if (s.nascimento !== nascimento) return { situacao: "divergente" };
    if (!/^P\d+$/.test(s.id)) return { situacao: "sem_id_definitivo" };
    return { situacao: "confere", klingo_id: s.id, faltando: s.faltando, plano_id: s.planoId, _plano_achado: s.planoId !== null, _contatos_achados: typeof (r as Record<string, unknown>)?.contatos === "object" };
  } catch (e) {
    if (e instanceof KlingoErro && e.tipo === "paciente_nao_identificado") return { situacao: "nao_encontrado" };
    return { situacao: "erro" };
  }
}
