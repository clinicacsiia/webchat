// Cliente da API externa do Klingo para AGENDA (horários livres e marcação).
// Fonte: https://app.swaggerhub.com/apis/agsx30/klingo-api-externa/1.0.0 (host api-externa.klingo.app, base /api).
// Sem dependência do Deno: o `fetch` entra por parâmetro para testar com dados inventados.
//
// Dois tipos de credencial (ver docs/klingo-api-agendamento.md):
//   X-APP-TOKEN = a chave da clínica (secret KLINGO_APP_TOKEN, a mesma dos relatórios);
//   Authorization: Bearer = a sessão do PACIENTE, obtida em /externo/login. Marcar, reservar e cancelar exigem.

export const KLINGO_API = "https://api-externa.klingo.app/api";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type Query = Record<string, string | number | boolean | undefined | null>;

export class KlingoErro extends Error {
  status: number;
  caminho: string;
  constructor(status: number, caminho: string, mensagem?: string) {
    super(`Klingo ${status} em ${caminho}${mensagem ? `: ${mensagem}` : ""}`);
    this.status = status;
    this.caminho = caminho;
  }
}

export type PedidoHorarios = {
  especialidade?: string;   // CBOS (consulta)
  exame?: string;           // código do exame
  inicio?: string;          // AAAA-MM-DD (padrão: hoje)
  fim?: string;             // AAAA-MM-DD (padrão da API: 10 dias após o início)
  crm?: string;
  cnes?: string;            // unidade
  plano?: string | number;  // operadora/plano
  revisao?: boolean;
  sexo?: string;            // só quando não há sessão do paciente
  nascimento?: string;      // só quando não há sessão do paciente
};

export type Horario = {
  id: string;               // chave do horário, ex.: "2023-08-28|3|2|1|08:00" (é o que se manda para reservar/marcar)
  data: string;
  hora: string;
  ordem_chegada: boolean;
  faixa_ordem_chegada: string | null;
  profissional: { id: string | null; nome: string | null; conselho: string | null; numero: string | null; uf: string | null; subespecialidade: string | null } | null;
  unidade: { nome: string | null; cnes: string | null } | null;
};

const texto = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const HORA = /^\d{2}:\d{2}/;

/**
 * Transforma a resposta de GET /agenda/horarios numa lista plana e enxuta.
 * O Swagger descreve `horarios` de cada dia só como "objeto com ID e horário", sem mostrar o formato.
 * Por isso aceita: {"<id>": "08:00"}, {"08:00": "<id>"}, ["08:00"] ou [{id, hora}], e, na falta do id,
 * monta "<id do dia>|08:00". CONFIRMAR com uma chamada real (ver docs) e então apertar esta função.
 */
export function normalizarHorarios(resposta: unknown): Horario[] {
  const dias = (resposta as { horarios?: unknown[] } | null)?.horarios;
  if (!Array.isArray(dias)) return [];
  const saida: Horario[] = [];
  for (const dia of dias as Record<string, unknown>[]) {
    const prof = dia.profissional as Record<string, unknown> | undefined;
    const uni = dia.unidade as Record<string, unknown> | undefined;
    const base = {
      data: String(dia.data ?? ""),
      ordem_chegada: dia.ordem_chegada === true,
      faixa_ordem_chegada: texto(dia.faixa_ordem_chegada),
      profissional: prof ? {
        id: texto(prof.id), nome: texto(prof.nome), conselho: texto(prof.conselho), numero: texto(prof.numero),
        uf: texto(prof.uf), subespecialidade: texto(prof.subespecialidade),
      } : null,
      unidade: uni ? { nome: texto(uni.nome), cnes: texto(uni.cnes) } : null,
    };
    const lista = dia.horarios;
    const pares: Array<[string, string]> = []; // [id, hora]
    if (Array.isArray(lista)) {
      for (const h of lista) {
        if (typeof h === "string") pares.push([`${dia.id ?? dia.data}|${h}`, h]);
        else if (h && typeof h === "object") {
          const o = h as Record<string, unknown>;
          const hora = String(o.hora ?? o.horario ?? "");
          if (HORA.test(hora)) pares.push([String(o.id ?? `${dia.id ?? dia.data}|${hora}`), hora]);
        }
      }
    } else if (lista && typeof lista === "object") {
      for (const [k, v] of Object.entries(lista as Record<string, unknown>)) {
        if (typeof v === "string" && HORA.test(v)) pares.push([k, v]);
        else if (typeof v === "string" && HORA.test(k)) pares.push([v, k]);
        else if (v && typeof v === "object") {
          const o = v as Record<string, unknown>;
          const hora = String(o.hora ?? o.horario ?? (HORA.test(k) ? k : ""));
          if (HORA.test(hora)) pares.push([String(o.id ?? k), hora]);
        }
      }
    }
    for (const [id, hora] of pares) saida.push({ ...base, id, hora: hora.slice(0, 5) });
  }
  return saida.sort((a, b) => (a.data + a.hora).localeCompare(b.data + b.hora));
}

export class KlingoApi {
  private appToken: string;
  private f: Fetcher;
  private base: string;
  constructor(appToken: string, f: Fetcher = (u, i) => fetch(u, i), base = KLINGO_API) {
    this.appToken = appToken;
    this.f = f;
    this.base = base;
  }

  private async chamar<T = unknown>(metodo: string, caminho: string, o: { query?: Query; corpo?: unknown; sessao?: string } = {}): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    const headers: Record<string, string> = { "X-APP-TOKEN": this.appToken, Accept: "application/json" };
    if (o.sessao) headers.Authorization = `Bearer ${o.sessao}`;
    if (o.corpo !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.f(`${this.base}${caminho}${q.size ? `?${q}` : ""}`, {
      method: metodo, headers, body: o.corpo === undefined ? undefined : JSON.stringify(o.corpo), signal: AbortSignal.timeout(20_000),
    });
    // Nunca devolver o corpo do erro: pode conter dado de paciente.
    if (!res.ok) throw new KlingoErro(res.status, caminho);
    const t = await res.text();
    try { return JSON.parse(t) as T; } catch { return t as unknown as T; }
  }

  /** GET /live — sem credencial. Responde algo como "OK [API1]". */
  versao() { return this.chamar<string>("GET", "/live"); }

  /** GET /agenda/horarios — só leitura. Com a sessão do paciente, a API já sabe sexo e idade. */
  async horarios(p: PedidoHorarios, sessao?: string): Promise<Horario[]> {
    if (!p.especialidade && !p.exame) throw new Error("informe especialidade (consulta) ou exame");
    const r = await this.chamar("GET", "/agenda/horarios", {
      sessao, query: { ...p, revisao: p.revisao === undefined ? undefined : p.revisao ? 1 : 0 },
    });
    return normalizarHorarios(r);
  }

  /** GET /agenda/horario_procedimentos — procedimentos que cabem num horário (a chave vem de `horarios`). */
  horarioProcedimentos(horario: string, sessao?: string) {
    return this.chamar("GET", "/agenda/horario_procedimentos", { sessao, query: { horario } });
  }

  /** GET /paciente/cpf — identifica o cadastro pelo CPF (11 dígitos). */
  pacientePorCpf(cpf: string) { return this.chamar<Record<string, unknown>>("GET", "/paciente/cpf", { query: { cpf } }); }

  /** POST /externo/login — sessão do paciente. O id vai precedido de "P" (ex.: P123). Devolve o access_token. */
  async login(idPaciente: string | number): Promise<string> {
    const r = await this.chamar<{ access_token?: string }>("POST", "/externo/login", { corpo: { id: `P${idPaciente}` } });
    if (!r?.access_token) throw new KlingoErro(0, "/externo/login", "sem access_token");
    return r.access_token;
  }

  /** POST /agenda/reservar — segura o horário por ~10 min, sem marcar. */
  reservar(sessao: string, m: Marcacao) { return this.chamar<{ id?: number | string; expira?: string }>("POST", "/agenda/reservar", { sessao, corpo: paraApi(m) }); }

  /** DELETE /agenda/reservar — solta a reserva. */
  cancelarReserva(sessao: string, idReserva: number | string) { return this.chamar("DELETE", "/agenda/reservar", { sessao, corpo: { id: Number(idReserva) } }); }

  /** POST /agenda/horario — MARCA de verdade e devolve o voucher. */
  marcar(sessao: string, m: Marcacao) { return this.chamar<Record<string, unknown>>("POST", "/agenda/horario", { sessao, corpo: paraApi(m) }); }
}

export type Marcacao = {
  horario: string;               // chave do horário (campo `id` do horário)
  procedimento: string;          // código do procedimento
  plano: number;                 // id do plano/operadora
  enviarEmail?: boolean;
  revisao?: boolean;
  idExterno?: string;            // id do pedido no nosso sistema
  obs?: string;
};

// O corpo do Swagger usa `id` para a chave do horário.
function paraApi(m: Marcacao) {
  return {
    id: m.horario, procedimento: m.procedimento, plano: m.plano, email: m.enviarEmail ?? false,
    ...(m.revisao ? { revisao: true } : {}), ...(m.idExterno ? { id_externo: m.idExterno } : {}), ...(m.obs ? { obs: m.obs } : {}),
  };
}

export const cpfDigitos = (v: unknown): string | null => { const d = String(v ?? "").replace(/\D/g, ""); return d.length === 11 ? d : null; };
export const dataIso = (v: unknown): string | null => {
  const s = String(v ?? "").trim(); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/) ?? s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [a, b, c] = s.includes("/") ? [m[3], m[2], m[1]] : [m[1], m[2], m[3]];
  const d = new Date(`${a}-${b}-${c}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== `${a}-${b}-${c}` ? null : `${a}-${b}-${c}`;
};
