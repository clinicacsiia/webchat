// Cliente da API externa do Klingo usado pela página pública /agendamento/ (sem Deno: o `fetch` entra por parâmetro para testar com dados inventados).
// Versão 1.0 — 13/11/2026. Próprio desta função (as outras têm a cópia compartilhada `klingo-api.ts`; esta precisa de mais rotas e fala com a internet aberta).
//
// Regras que este cliente cumpre (ver docs/klingo-api-externa/GUIA-COMPLETO.md):
//  - NUNCA devolve nem registra o corpo de um erro do Klingo (pode ter CPF ou nome): só status, caminho e um tipo interno.
//  - 429: espera e tenta de novo (até 2 vezes), avisando a cota global para pausar todo mundo.
//  - Resposta HTML no lugar de JSON (403 de laudo, 429) é erro, nunca é lida como JSON.
//  - Antes de cada chamada, pede uma ficha da cota global (`antes`).

export const KLINGO_API = "https://api-externa.klingo.app/api";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type Query = Record<string, string | number | boolean | undefined | null>;

export type TipoErro =
  | "limite" | "plano_inativo" | "plano_desconhecido" | "sem_medico" | "horario_ocupado" | "ja_cancelado" | "paciente_nao_identificado"
  | "outra_data" | "html" | "nao_autorizado" | "servidor" | "timeout" | "rede" | "sem_token" | "outro";

export class KlingoErro extends Error {
  status: number;
  caminho: string;
  tipo: TipoErro;
  constructor(status: number, caminho: string, tipo: TipoErro = "outro") {
    super(`Klingo ${status} em ${caminho} (${tipo})`);
    this.status = status;
    this.caminho = caminho;
    this.tipo = tipo;
  }
  /** Depois de um POST que cria algo, estes erros não dizem se o Klingo criou ou não: o resultado é INCERTO. */
  get incerto() { return this.tipo === "timeout" || this.tipo === "rede" || this.tipo === "servidor" || this.tipo === "html" || this.tipo === "limite"; }
}

/** Olha o texto do erro SÓ para classificar; o texto nunca sai daqui. */
export function classificar(status: number, texto: string): TipoErro {
  if (status === 429) return "limite";
  if (/Plano .{0,80}inativ/i.test(texto)) return "plano_inativo";
  if (/Plano n[ãa]o identificado/i.test(texto)) return "plano_desconhecido";
  if (/Nenhum m[ée]dico credenciado/i.test(texto)) return "sem_medico";
  if (/Hor[áa]rio j[áa] ocupado/i.test(texto)) return "horario_ocupado";
  if (/j[áa] cancelado/i.test(texto)) return "ja_cancelado";
  if (/PACIENTE_NAO_IDENTIFICADO/.test(texto)) return "paciente_nao_identificado";
  if (/outra data/i.test(texto)) return "outra_data";
  if (/^\s*</.test(texto)) return "html";
  if (status === 401) return "nao_autorizado";
  if (status >= 500) return "servidor";
  return "outro";
}

export type Opcoes = {
  antes?: () => Promise<void>;
  aoLimite?: () => Promise<void> | void;
  esperar?: (ms: number) => Promise<void>;
  base?: string;
  timeoutMs?: number;
  tentativas429?: number;
};

export type Horario = {
  id: string;               // chave do horário "data|médico|agenda|unidade|hora"
  data: string;
  hora: string;
  procedimento: string | null;
  ordem_chegada: boolean;
  faixa_ordem_chegada: string | null;
  profissional: { id: string | null; nome: string | null; conselho: string | null; numero: string | null; uf: string | null; subespecialidade: string | null } | null;
  unidade: { id: string | null; nome: string | null; sigla: string | null } | null;
};

const texto = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const HORA = /^\d{2}:\d{2}/;

/** GET /agenda/horarios -> lista plana. Formato real (12/11/2026): `horarios` de cada dia é {"2026-11-16|63|308|2|13:40": "13:40"}. */
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
      procedimento: texto(dia.procedimento),
      profissional: prof ? {
        id: texto(prof.id), nome: texto(prof.nome), conselho: texto(prof.conselho), numero: texto(prof.numero),
        uf: texto(prof.uf), subespecialidade: texto(prof.subespecialidade),
      } : null,
      unidade: uni ? { id: texto(uni.id), nome: texto(uni.nome), sigla: texto(uni.sigla) } : null,
    };
    const lista = dia.horarios;
    const pares: Array<[string, string]> = [];
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

/** CPF com 11 dígitos e dígitos verificadores corretos (devolve só os dígitos). */
export function cpfValido(v: unknown): string | null {
  const d = String(v ?? "").replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return null;
  const dv = (n: number) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]) ? d : null;
}

export const dataIso = (v: unknown): string | null => {
  const s = String(v ?? "").trim(); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/) ?? s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [a, b, c] = s.includes("/") ? [m[3], m[2], m[1]] : [m[1], m[2], m[3]];
  const d = new Date(`${a}-${b}-${c}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== `${a}-${b}-${c}` ? null : `${a}-${b}-${c}`;
};

/** Chaves que NUNCA saem numa resposta pública de catálogo (cadastro de profissional pode trazer CPF e foto). */
const CHAVES_PESSOAIS = new Set(["cpf", "rg", "foto", "email", "celular", "telefone", "docs", "contatos"]);
export function limparCatalogo<T>(v: T): T {
  if (Array.isArray(v)) return v.map(limparCatalogo) as unknown as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!CHAVES_PESSOAIS.has(k.toLowerCase())) o[k] = limparCatalogo(x);
    return o as T;
  }
  return v;
}

const mascararCelular = (v: unknown) => { const d = String(v ?? "").replace(/\D/g, ""); return d.length >= 8 ? `(••) •••••-${d.slice(-4)}` : null; };
const mascararEmail = (v: unknown) => { const s = String(v ?? "").trim(); const i = s.indexOf("@"); return i > 0 ? `${s.slice(0, 1)}•••${s.slice(i)}` : null; };

/** Cadastro do paciente para mostrar a ele mesmo: contatos mascarados; sem CPF, RG, mãe nem endereço. */
export function resumoCadastro(r: unknown) {
  const o = (r ?? {}) as Record<string, unknown>;
  const ct = (o.contatos ?? {}) as Record<string, unknown>;
  const cv = (o.convenio ?? {}) as Record<string, unknown>;
  const pl = (cv.plano ?? {}) as Record<string, unknown>;
  return {
    nome: texto(o.nome), nascimento: dataIso(o.dt_nasc), sexo: texto(o.sexo),
    celular: mascararCelular(ct.celular), telefone: mascararCelular(ct.telefone), email: mascararEmail(ct.email),
    convenio: texto(cv.nome), plano: texto(pl.nome ?? cv.plano_nome), plano_id: Number.isInteger(Number(cv.id_plano ?? pl.id)) ? Number(cv.id_plano ?? pl.id) || null : null,
  };
}

/** Voucher enxuto (sem nome nem dado do paciente). */
export function resumoVoucher(v: Record<string, unknown> | null | undefined) {
  const proc = v?.procedimento as Record<string, unknown> | string | undefined, uni = v?.unidade as Record<string, unknown> | undefined, rea = v?.realizador as Record<string, unknown> | undefined;
  const reaProf = (rea?.profissional ?? rea) as Record<string, unknown> | undefined;
  return {
    id: v?.id === undefined || v?.id === null ? null : String(v.id), status: texto(v?.status), tipo: texto(v?.tipo), data: texto(v?.data), hora: texto(v?.hora)?.slice(0, 5) ?? null,
    procedimento: typeof proc === "object" ? texto(proc?.descr) : texto(proc), procedimento_id: typeof proc === "object" && proc?.id !== undefined ? texto(proc.id) : null,
    unidade: texto(uni?.nome), profissional: texto(reaProf?.nome), idExterno: texto(v?.id_externo),
  };
}

export class KlingoApi {
  private appToken: string;
  private f: Fetcher;
  private o: Required<Pick<Opcoes, "base" | "timeoutMs" | "tentativas429">> & Opcoes;
  constructor(appToken: string, f: Fetcher = (u, i) => fetch(u, i), opcoes: Opcoes = {}) {
    this.appToken = appToken;
    this.f = f;
    this.o = { base: KLINGO_API, timeoutMs: 20_000, tentativas429: 2, ...opcoes };
  }

  /** Chamada genérica: o mesmo caminho para tudo, com cota, 429, HTML e erro sem corpo. */
  async chamar<T = unknown>(metodo: string, caminho: string, o: { query?: Query; corpo?: unknown; sessao?: string; timeoutMs?: number } = {}): Promise<T> {
    if (!this.appToken) throw new KlingoErro(0, caminho, "sem_token");
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    const headers: Record<string, string> = { "X-APP-TOKEN": this.appToken, Accept: "application/json" };
    if (o.sessao) headers.Authorization = `Bearer ${o.sessao}`;
    if (o.corpo !== undefined) headers["Content-Type"] = "application/json";
    const esperar = this.o.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let tentativa = 0; ; tentativa++) {
      if (this.o.antes) await this.o.antes();
      let res: Response;
      try {
        res = await this.f(`${this.o.base}${caminho}${q.size ? `?${q}` : ""}`, {
          method: metodo, headers, body: o.corpo === undefined ? undefined : JSON.stringify(o.corpo), signal: AbortSignal.timeout(o.timeoutMs ?? this.o.timeoutMs),
        });
      } catch (e) {
        throw new KlingoErro(0, caminho, (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError" ? "timeout" : "rede");
      }
      const t = await res.text().catch(() => "");
      if (res.status === 429) {
        if (this.o.aoLimite) await this.o.aoLimite();
        if (tentativa < this.o.tentativas429) { await esperar(800 * 2 ** tentativa); continue; }
        throw new KlingoErro(429, caminho, "limite");
      }
      if (!res.ok) throw new KlingoErro(res.status, caminho, classificar(res.status, t));
      if (/^\s*</.test(t) && /html/i.test(res.headers.get("content-type") ?? "html")) throw new KlingoErro(res.status, caminho, "html");
      try { return JSON.parse(t) as T; } catch { return t as unknown as T; }
    }
  }

  versao() { return this.chamar<string>("GET", "/live"); }
  async horarios(p: Query, sessao?: string): Promise<Horario[]> { return normalizarHorarios(await this.chamar("GET", "/agenda/horarios", { sessao, query: p })); }
  pacientePorCpf(cpf: string) { return this.chamar<Record<string, unknown>>("GET", "/paciente/cpf", { query: { cpf } }); }

  /** POST /externo/login. O id vai EXATAMENTE como o Klingo o devolveu: definitivo "P123456"; pré-cadastro o número puro (com P abre OUTRO paciente). */
  async login(idLogin: string): Promise<{ token: string; user: Record<string, unknown> }> {
    const r = await this.chamar<{ access_token?: string; user?: Record<string, unknown> }>("POST", "/externo/login", { corpo: { id: String(idLogin) } });
    if (!r?.access_token) throw new KlingoErro(0, "/externo/login", "outro");
    return { token: r.access_token, user: r.user ?? {} };
  }

  /** POST /externo/register — cria um PRÉ-CADASTRO. A API não evita duplicar o mesmo CPF: quem chama trava por CPF antes. */
  async registrar(p: { nome: string; sexo: string; nascimento: string; cpf: string; celular?: string; email?: string; mae?: string }): Promise<{ id: string }> {
    const r = await this.chamar<{ id?: number | string }>("POST", "/externo/register", {
      corpo: { paciente: { nome: p.nome, sexo: p.sexo, dt_nasc: p.nascimento, ...(p.mae ? { mae: p.mae } : {}), docs: { cpf: p.cpf },
        contatos: { ...(p.celular ? { celular: p.celular } : {}), ...(p.email ? { email: p.email } : {}) } } },
    });
    const id = String(r?.id ?? "");
    if (!/^\d+$/.test(id)) throw new KlingoErro(200, "/externo/register", "outro");
    return { id };
  }
}

/**
 * Cota global (tabela klingo_cota no banco): pede 1 ficha antes de cada chamada ao Klingo. Versão da página pública: espera pouco
 * (no máximo ~`maxEsperaMs` por ficha e `maxTentativas` vezes) e desiste com erro "limite", para o tráfego aberto nunca segurar as rotinas internas.
 */
export function cotaGlobal(
  rpc: (nome: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown }>,
  o: { maxTentativas?: number; maxEsperaMs?: number; esperar?: (ms: number) => Promise<void> } = {},
) {
  const esperar = o.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async () => {
    for (let i = 0; i < (o.maxTentativas ?? 4); i++) {
      const { data } = await rpc("klingo_cota_pegar", { p_n: 1 });
      const d = (data ?? {}) as { ok?: boolean; espera_ms?: number };
      if (d.ok) return;
      await esperar(Math.min(Math.max(Number(d.espera_ms ?? 1000), 50), o.maxEsperaMs ?? 2000));
    }
    throw new KlingoErro(0, "cota", "limite");
  };
}
