// Cliente da API externa do Klingo (host api-externa.klingo.app, base /api) usado pelo autoatendimento.
// Versão 1.0 — 12/11/2026. ESTE ARQUIVO É COPIADO IGUAL para klingo-executar, chat-agenda-api, klingo-identificar e klingo-sincronizar
// (as Edge Functions publicam cada pasta isolada); o teste klingo-auto.test.ts confere que as quatro cópias são idênticas.
// Sem dependência do Deno: o `fetch` entra por parâmetro para testar com dados inventados.
//
// Regras que este cliente cumpre (ver docs/klingo-api-externa/GUIA-COMPLETO.md):
//  - NUNCA devolve nem registra o corpo de um erro (pode ter CPF ou nome). Só status, caminho e um tipo interno (`KlingoErro.tipo`).
//  - 429 (limite): espera e tenta de novo até 3 vezes, avisando quem chamou (`aoLimite`) para pausar a cota global.
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
  /** Só para /agenda/horarios (a consulta não leva CPF nem nome): trecho curto da mensagem do Klingo, para a equipe saber o motivo do 403. */
  resumo?: string;
  constructor(status: number, caminho: string, tipo: TipoErro = "outro") {
    super(`Klingo ${status} em ${caminho} (${tipo})`);
    this.status = status;
    this.caminho = caminho;
    this.tipo = tipo;
  }
  /** Depois de um POST que cria algo, estes erros não dizem se o Klingo criou ou não: o resultado é INCERTO. */
  get incerto() { return this.tipo === "timeout" || this.tipo === "rede" || this.tipo === "servidor" || this.tipo === "html" || this.tipo === "limite"; }
}

/** JSON -> texto corrido com os acentos de verdade (para casar as frases conhecidas). Não é JSON? devolve vazio. */
function decodificarJson(t: string): string {
  try { const j = JSON.parse(t) as unknown; return typeof j === "string" ? j : JSON.stringify(j); } catch { return ""; }
}

/** Olha o texto do erro SÓ para classificar; o texto nunca sai daqui. */
export function classificar(status: number, bruto: string): TipoErro {
  // A API às vezes manda os acentos escapados no JSON (\u00e9): lê o texto cru E o decodificado (11/13/2026: "Nenhum m\u00e9dico credenciado" virava "outro").
  const texto = `${bruto} ${decodificarJson(bruto)}`;
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

/** Trecho curto e sem quebras da mensagem de erro (JSON {msg} ou campos de validação). Usado só onde a requisição não carrega dado pessoal. */
export function resumirMensagem(texto: string, max = 160): string {
  let m = String(texto ?? "");
  try {
    const j = JSON.parse(m) as unknown;
    if (typeof j === "string") m = j;
    else if (j && typeof j === "object") {
      const o = j as Record<string, unknown>;
      m = typeof o.msg === "string" ? o.msg : JSON.stringify(j);
    }
  } catch { /* texto puro */ }
  return m.replace(/\s+/g, " ").trim().slice(0, max);
}

export type Opcoes = {
  /** Chamado antes de CADA requisição (aqui entra a cota global). Pode esperar. */
  antes?: () => Promise<void>;
  /** Chamado quando o Klingo responde 429 (aqui a cota global pausa todo mundo). */
  aoLimite?: () => Promise<void> | void;
  esperar?: (ms: number) => Promise<void>;
  base?: string;
  timeoutMs?: number;
  tentativas429?: number;
};

export type PedidoHorarios = {
  especialidade?: string;   // CBOS (consulta)
  exame?: string;           // id do exame
  inicio?: string;          // AAAA-MM-DD
  fim?: string;
  crm?: string;
  cnes?: string;
  plano?: string | number;
  revisao?: boolean;
  sexo?: string;            // só quando não há sessão do paciente
  nascimento?: string;      // só quando não há sessão do paciente
};

export type Horario = {
  id: string;               // chave do horário "data|médico|agenda|unidade|hora"
  data: string;
  hora: string;
  procedimento: string | null;
  ordem_chegada: boolean;
  faixa_ordem_chegada: string | null;
  profissional: { id: string | null; nome: string | null; conselho: string | null; numero: string | null; uf: string | null; subespecialidade: string | null } | null;
  unidade: { id: string | null; nome: string | null; sigla: string | null; cnes: string | null } | null;
};

export type Marcacao = {
  horario: string;          // chave do horário
  procedimento: string;
  plano: number;
  enviarEmail?: boolean;
  revisao?: boolean;
  idExterno?: string;
  obs?: string;
  remarcacao?: number | string;   // id do voucher antigo: o Klingo cancela sozinho
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
      unidade: uni ? { id: texto(uni.id), nome: texto(uni.nome), sigla: texto(uni.sigla), cnes: texto(uni.cnes) } : null,
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

export const cpfDigitos = (v: unknown): string | null => { const d = String(v ?? "").replace(/\D/g, ""); return d.length === 11 ? d : null; };
export const dataIso = (v: unknown): string | null => {
  const s = String(v ?? "").trim(); const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/) ?? s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [a, b, c] = s.includes("/") ? [m[3], m[2], m[1]] : [m[1], m[2], m[3]];
  const d = new Date(`${a}-${b}-${c}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== `${a}-${b}-${c}` ? null : `${a}-${b}-${c}`;
};
export const semAcento = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();

/** Resumo SEM dado pessoal de GET /paciente/cpf: id, nascimento, quais contatos faltam e o plano cadastrado. */
export function resumoPaciente(r: unknown): { id: string | null; nascimento: string | null; faltando: string[]; planoId: number | null } {
  const o = (r ?? {}) as Record<string, unknown>;
  const ct = (o.contatos ?? {}) as Record<string, unknown>;
  const cv = (o.convenio ?? {}) as Record<string, unknown>;
  const pl = (cv.plano ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  const faltando = ["email", "celular", "telefone"].filter((k) => !String(ct[k] ?? "").trim());
  return { id: texto(o.id), nascimento: dataIso(o.dt_nasc), faltando, planoId: num(cv.id_plano) ?? num(pl.id) ?? null };
}

/** Só para comparar em memória com o que o paciente digitou (nunca devolver, gravar nem registrar em log). */
export function cadastroParaComparar(r: unknown): { nome: string | null; mae: string | null; sexo: string | null; celulares: string[]; email: string | null } {
  const o = (r ?? {}) as Record<string, unknown>;
  const ct = (o.contatos ?? {}) as Record<string, unknown>;
  const digitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");
  const sx = String(o.sexo ?? "").trim().toUpperCase().slice(0, 1);
  return {
    nome: texto(o.nome), mae: texto(o.mae), sexo: sx === "M" || sx === "F" ? sx : null,
    celulares: [ct.celular, ct.telefone].map(digitos).filter((x) => x.length >= 8), email: texto(ct.email)?.toLowerCase() ?? null,
  };
}

/**
 * Compara o que o paciente digitou com o cadastro do Klingo (o Klingo é sempre a verdade). Devolve só os NOMES dos campos que divergem,
 * nunca os valores. Campo vazio de um dos lados não conta como divergência (vira "atualizar cadastro" para a equipe).
 */
export function camposDivergentes(
  k: { nome: string | null; mae: string | null; sexo: string | null; celulares: string[]; email: string | null },
  d: { nome: string | null; mae?: string | null; sexo: string | null; celular: string | null; email: string | null },
): string[] {
  const lig = new Set(["DE", "DA", "DO", "DAS", "DOS", "E"]);
  const toks = (v: unknown) => semAcento(v).split(" ").filter((t) => t && !lig.has(t));
  const mesmoNome = (a: unknown, b: unknown) => {
    const x = toks(a), y = toks(b);
    if (!x.length || !y.length) return true;
    return x.join(" ") === y.join(" ") || (x[0] === y[0] && x[x.length - 1] === y[y.length - 1] && x.filter((t) => y.includes(t)).length >= Math.min(x.length, y.length));
  };
  const out: string[] = [];
  if (!mesmoNome(k.nome, d.nome)) out.push("nome");
  if (!mesmoNome(k.mae, d.mae)) out.push("mae");
  if (k.sexo && d.sexo && k.sexo !== String(d.sexo).trim().toUpperCase().slice(0, 1)) out.push("sexo");
  const cel = String(d.celular ?? "").replace(/\D/g, "").slice(-8);
  if (k.celulares.length && cel.length === 8 && !k.celulares.some((c) => c.slice(-8) === cel)) out.push("telefone");
  if (k.email && d.email && k.email !== String(d.email).trim().toLowerCase()) out.push("email");
  return out;
}

export class KlingoApi {
  private appToken: string;
  private f: Fetcher;
  private o: Required<Pick<Opcoes, "base" | "timeoutMs" | "tentativas429">> & Opcoes;
  constructor(appToken: string, f: Fetcher = (u, i) => fetch(u, i), opcoes: Opcoes = {}) {
    this.appToken = appToken;
    this.f = f;
    this.o = { base: KLINGO_API, timeoutMs: 20_000, tentativas429: 3, ...opcoes };
  }

  private async chamar<T = unknown>(metodo: string, caminho: string, o: { query?: Query; corpo?: unknown; sessao?: string; timeoutMs?: number } = {}): Promise<T> {
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
      if (!res.ok) {
        const e = new KlingoErro(res.status, caminho, classificar(res.status, t));
        if (caminho === "/agenda/horarios") e.resumo = resumirMensagem(t);
        throw e;
      }
      if (/^\s*</.test(t) && /html/i.test(res.headers.get("content-type") ?? "html")) throw new KlingoErro(res.status, caminho, "html");
      try { return JSON.parse(t) as T; } catch { return t as unknown as T; }
    }
  }

  /** GET /live — sem credencial útil, só confere se está no ar. */
  versao() { return this.chamar<string>("GET", "/live"); }
  convenios() { return this.chamar<Array<Record<string, unknown>>>("GET", "/convenios"); }
  especialidades() { return this.chamar<Array<Record<string, unknown>>>("GET", "/agenda/especialidades"); }
  consultas(cbos: string) { return this.chamar<Array<Record<string, unknown>>>("GET", "/agenda/consultas", { query: { cbos } }); }

  async horarios(p: PedidoHorarios, sessao?: string): Promise<Horario[]> {
    if (!p.especialidade && !p.exame) throw new Error("informe especialidade (consulta) ou exame");
    const r = await this.chamar("GET", "/agenda/horarios", { sessao, query: { ...p, revisao: p.revisao === undefined ? undefined : p.revisao ? 1 : 0 } });
    return normalizarHorarios(r);
  }

  /** GET /paciente/cpf — cadastro pelo CPF (11 dígitos). Não acha quem só tem pré-cadastro. */
  pacientePorCpf(cpf: string) { return this.chamar<Record<string, unknown>>("GET", "/paciente/cpf", { query: { cpf } }); }

  /**
   * POST /externo/login. O id vai EXATAMENTE como o Klingo o devolveu: definitivo "P123456"; pré-cadastro o número puro (com P abre OUTRO paciente).
   * Devolve o token e o `user` para o chamador CONFERIR quem é antes de reservar ou marcar.
   */
  async login(idLogin: string): Promise<{ token: string; user: Record<string, unknown> }> {
    const r = await this.chamar<{ access_token?: string; user?: Record<string, unknown> }>("POST", "/externo/login", { corpo: { id: String(idLogin) } });
    if (!r?.access_token) throw new KlingoErro(0, "/externo/login", "outro");
    return { token: r.access_token, user: r.user ?? {} };
  }

  /** POST /externo/register — cria um PRÉ-CADASTRO. A API não evita duplicar o mesmo CPF: quem chama precisa travar por CPF antes. */
  async registrar(p: { nome: string; sexo: string; nascimento: string; cpf: string; celular?: string; email?: string; mae?: string }): Promise<{ id: string }> {
    const r = await this.chamar<{ id?: number | string }>("POST", "/externo/register", {
      corpo: { paciente: { nome: p.nome, sexo: p.sexo, dt_nasc: p.nascimento, ...(p.mae ? { mae: p.mae } : {}), docs: { cpf: p.cpf },
        contatos: { ...(p.celular ? { celular: p.celular } : {}), ...(p.email ? { email: p.email } : {}) } } },
    });
    const id = String(r?.id ?? "");
    if (!/^\d+$/.test(id)) throw new KlingoErro(200, "/externo/register", "outro");
    return { id };
  }

  reservar(sessao: string, m: Marcacao) { return this.chamar<{ id?: number | string; expira?: string }>("POST", "/agenda/reservar", { sessao, corpo: paraApi(m) }); }
  cancelarReserva(sessao: string, idReserva: number | string) { return this.chamar("DELETE", "/agenda/reservar", { sessao, corpo: { id: Number(idReserva) } }); }
  /** POST /agenda/horario — MARCA de verdade e devolve o voucher. Timeout maior: a marcação é lenta. */
  marcar(sessao: string, m: Marcacao) { return this.chamar<Record<string, unknown>>("POST", "/agenda/horario", { sessao, corpo: paraApi(m), timeoutMs: 25_000 }); }
  /** GET /vouchers — marcações ATIVAS da sessão. */
  vouchers(sessao: string) { return this.chamar<Array<Record<string, unknown>>>("GET", "/vouchers", { sessao }); }
  /** DELETE /voucher — cancela. O horário volta à lista na hora. */
  cancelarVoucher(sessao: string, id: number | string) { return this.chamar("DELETE", "/voucher", { sessao, corpo: { id: String(id) } }); }
}

function paraApi(m: Marcacao) {
  return {
    id: m.horario, procedimento: m.procedimento, plano: m.plano, email: m.enviarEmail ?? false,
    ...(m.revisao ? { revisao: true } : {}), ...(m.idExterno ? { id_externo: m.idExterno } : {}), ...(m.obs ? { obs: m.obs } : {}),
    ...(m.remarcacao !== undefined ? { remarcacao: Number(m.remarcacao) } : {}),
  };
}

/** Voucher enxuto (sem nome nem dado do paciente). */
export function resumoVoucher(v: Record<string, unknown> | null | undefined) {
  const proc = v?.procedimento as Record<string, unknown> | string | undefined, uni = v?.unidade as Record<string, unknown> | undefined, rea = v?.realizador as Record<string, unknown> | undefined;
  return {
    id: v?.id === undefined || v?.id === null ? null : String(v.id), status: texto(v?.status), data: texto(v?.data), hora: texto(v?.hora)?.slice(0, 5) ?? null,
    procedimento: typeof proc === "object" ? texto(proc?.descr) : texto(proc), unidade: texto(uni?.nome), profissional: texto(rea?.nome), idExterno: texto(v?.id_externo),
  };
}

/**
 * Cota global (tabela klingo_cota no banco): pede 1 ficha antes de cada chamada ao Klingo e espera a reposição (no máximo `maxTentativas` vezes).
 * `rpc` é o supabase.rpc do service_role. Se a cota não liberar a tempo, lança erro "limite" (o chamador cai para o plano B).
 */
export function cotaGlobal(
  rpc: (nome: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown }>,
  o: { maxTentativas?: number; maxEsperaMs?: number; esperar?: (ms: number) => Promise<void> } = {},
) {
  const esperar = o.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async () => {
    for (let i = 0; i < (o.maxTentativas ?? 8); i++) {
      const { data } = await rpc("klingo_cota_pegar", { p_n: 1 });
      const d = (data ?? {}) as { ok?: boolean; espera_ms?: number };
      if (d.ok) return;
      await esperar(Math.min(Math.max(Number(d.espera_ms ?? 1000), 50), o.maxEsperaMs ?? 5000));
    }
    throw new KlingoErro(0, "cota", "limite");
  };
}
