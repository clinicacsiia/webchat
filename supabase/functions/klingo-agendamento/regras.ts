// Regras da página pública /agendamento/ (sem Deno: o banco e a API entram por parâmetro para testar com dados inventados).
// Versão 1.0 — 13/11/2026.
//
// Dois grupos de ações (corpo JSON {"acao": "...", ...}):
//  A) SEM IDENTIDADE (catálogos e horários; só leitura): versao, horarios, catalogo (unidades, especialidades, consultas, exames, convenios, convenio_cnpj,
//     profissionais, profissional, profissionais_procedimento, preco, precos, recepcoes, regioes_cd, horario_procedimentos), requisicao.
//  B) COM IDENTIDADE (cpf + nascimento a cada chamada; a função confere no Klingo ANTES e DEPOIS do login): identificar, meus_dados, atualizar_contato,
//     minhas_marcacoes, reservar, soltar, marcar, remarcar, cancelar, trocar_procedimento, checkin, cancelar_checkin, resultado, autorizacoes, e cadastrar (paciente novo).
//
// O QUE NUNCA FAZ (de propósito): adiantamento, pagamento, registrar_atendimento, formas_de_pagamento (dinheiro: validar com o suporte do Klingo antes),
// /atendimentos (devolve os dados de todos os pacientes do dia), portal (cria conta e manda e-mail), identificar só por telefone, GET com corpo.
//
// Segurança embutida (ver docs/klingo-api-externa/GUIA-COMPLETO.md, itens 2.2, 2.3 e 8):
//  - o id de login vem do Klingo EXATAMENTE como veio (definitivo "P123", pré-cadastro número puro) e a sessão é conferida (id e nascimento) antes de qualquer ação;
//  - cancelar, remarcar, trocar procedimento, check-in e resultado só mexem em voucher que está entre as marcações ATIVAS da sessão do próprio paciente;
//  - cinco nascimentos errados para o mesmo CPF em 1 hora travam o CPF (a página não vira um jeito de adivinhar datas);
//  - paciente novo: trava por CPF ANTES de registrar (a API aceita duplicar) e teto diário de pré-cadastros;
//  - nunca devolve nem registra corpo de erro do Klingo; nada de paciente vai para log; contatos voltam mascarados.
import { cpfValido, dataIso, type Horario, KlingoApi, KlingoErro, limparCatalogo, resumoCadastro, resumoVoucher } from "./api.ts";

export type Resp = { status: number; corpo: Record<string, unknown> };
export type Banco = {
  hash(texto: string): Promise<string>;
  /** Quantos nascimentos DIFERENTES já foram recusados para este CPF na última hora. */
  divergentesRecentes(cpfHash: string): Promise<number>;
  registrarIdentidade(cpf: string, nascimento: string, r: Record<string, unknown>): Promise<void>;
  /** Pré-cadastro guardado para o par CPF + nascimento (tipo "pre"). */
  preDoPar(cpf: string, nascimento: string): Promise<{ klingo_id: string | null } | null>;
  /** Trava por CPF (índice único): cria a marca "pré-cadastro em andamento" ou devolve a que já existe. */
  reservarPre(cpf: string, nascimento: string): Promise<{ criado: boolean; mesmoPar: boolean; klingo_id: string | null; idadeMin: number }>;
  gravarPre(cpf: string, nascimento: string, klingoId: string): Promise<void>;
  soltarPre(cpf: string, nascimento: string): Promise<void>;
  precadastrosRecentes(): Promise<number>;
};
/** `resultado`: entrega de laudo ligada? Desligada por padrão (decisão do dono de 03/11/2026: link e senha do resultado são passados pela equipe); liga com o secret AGENDAMENTO_RESULTADO=1. */
export type Ctx = { api: KlingoApi; db: Banco; hoje: () => string; agora: () => number; uuid: () => string; cache: Map<string, { ate: number; v: unknown }>; resultado?: boolean };

const MAX_TENTATIVAS_CPF = 5, MAX_PRE_DIA = 40, TTL_CATALOGO_MS = 60_000, TTL_HORARIOS_MS = 20_000, MAX_DIAS = 31;

const ok = (corpo: Record<string, unknown> = {}): Resp => ({ status: 200, corpo: { ok: true, ...corpo } });
const nega = (motivo: string, extra: Record<string, unknown> = {}, status = 200): Resp => ({ status, corpo: { ok: false, motivo, ...extra } });
const invalido = (campo: string): Resp => nega("dados_invalidos", { campo }, 400);

/** Texto curto, sem quebra de linha nem caractere de controle. */
const curto = (v: unknown, max = 80, min = 1): string | null => { const s = String(v ?? "").trim(); return s.length >= min && s.length <= max && !/[\u0000-\u001f\u007f]/.test(s) ? s : null; };
const digitos = (v: unknown, min: number, max: number): string | null => { const s = String(v ?? "").trim(); return new RegExp(`^\\d{${min},${max}}$`).test(s) ? s : null; };
const booleano = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
const CHAVE_HORARIO = /^\d{4}-\d{2}-\d{2}\|\d{1,9}\|\d{1,9}\|\d{1,9}\|\d{2}:\d{2}$/;
const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const somarDias = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Erro do Klingo -> resposta da página (só status e caminho; o corpo do Klingo nunca sai). */
export function traduzir(e: unknown): Resp {
  if (e instanceof KlingoErro) {
    if (e.tipo === "limite") return nega("limite", { mensagem: "O sistema da clínica está muito ocupado. Tente de novo em alguns segundos." }, 429);
    if (e.tipo === "plano_inativo" || e.tipo === "plano_desconhecido" || e.tipo === "sem_medico" || e.tipo === "horario_ocupado" || e.tipo === "ja_cancelado" || e.tipo === "outra_data") return nega(e.tipo, { caminho: e.caminho });
    return nega("klingo_recusou", { status: e.status, caminho: e.caminho, tipo: e.tipo }, 502);
  }
  return nega("erro", {}, 500);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// A) Sem identidade
// ---------------------------------------------------------------------------------------------------------------------------------------------
type Param = "int" | "texto" | "bool" | "cnpj";
type Catalogo = { caminho: string; q: Record<string, Param>; obrigatorios?: string[] };
const CATALOGOS: Record<string, Catalogo> = {
  unidades: { caminho: "/unidades", q: { classe_unidade: "texto" } },
  especialidades: { caminho: "/agenda/especialidades", q: { cbos: "texto", cnes: "texto", id_plano: "int", consultas: "bool" } },
  consultas: { caminho: "/agenda/consultas", q: { cbos: "texto", id_especialidade: "int", cnes: "texto" } },
  exames: { caminho: "/agenda/exames", q: { id: "int", busca: "texto" } },
  convenios: { caminho: "/convenios", q: { cnes: "texto" } },
  profissionais: { caminho: "/profissionais", q: { especialidade: "texto", id_especialidade: "int", agenda_compartilhada: "bool", vinculos: "bool", cnes: "texto" } },
  profissional: { caminho: "/profissional", q: { id_medico: "int" }, obrigatorios: ["id_medico"] },
  profissionais_procedimento: { caminho: "/agenda/profissionais", q: { id_procedimento: "int", id_plano: "int", cnes: "texto", agenda_compartilhada: "bool" }, obrigatorios: ["id_procedimento", "id_plano"] },
  preco: { caminho: "/preco", q: { id_procedimento: "int", id_plano: "int", id_medico: "int", id_unidade: "int" }, obrigatorios: ["id_procedimento", "id_plano"] },
  precos: { caminho: "/precos", q: { id_plano: "int", id_medico: "int", id_unidade: "int", page: "int" }, obrigatorios: ["id_plano"] },
  recepcoes: { caminho: "/recepcoes", q: { cnes: "texto" }, obrigatorios: ["cnes"] },
  regioes_cd: { caminho: "/regiao_cd", q: { cnes: "texto" }, obrigatorios: ["cnes"] },
  horario_procedimentos: { caminho: "/agenda/horario_procedimentos", q: { horario: "texto" }, obrigatorios: ["horario"] },
};

async function comCache<T>(ctx: Ctx, chave: string, ttl: number, buscar: () => Promise<T>): Promise<T> {
  const c = ctx.cache.get(chave);
  if (c && c.ate > ctx.agora()) return c.v as T;
  const v = await buscar();
  ctx.cache.set(chave, { ate: ctx.agora() + ttl, v });
  if (ctx.cache.size > 300) for (const [k, x] of ctx.cache) if (x.ate <= ctx.agora()) ctx.cache.delete(k);
  return v;
}

function parametrosCatalogo(def: Catalogo, c: Record<string, unknown>): Record<string, string> | Resp {
  const q: Record<string, string> = {};
  for (const [nome, tipo] of Object.entries(def.q)) {
    const v = c[nome];
    if (v === undefined || v === null || v === "") continue;
    if (tipo === "int") { const d = digitos(v, 1, 9); if (!d) return invalido(nome); q[nome] = d; }
    else if (tipo === "bool") q[nome] = booleano(v) ? "1" : "0";
    else { const t = curto(v, 60); if (!t) return invalido(nome); q[nome] = t; }
  }
  for (const o of def.obrigatorios ?? []) if (!(o in q)) return invalido(o);
  if (q.horario && !CHAVE_HORARIO.test(q.horario)) return invalido("horario");
  return q;
}

async function horarios(ctx: Ctx, c: Record<string, unknown>): Promise<Resp> {
  const especialidade = c.especialidade ? curto(c.especialidade, 20) : null, exame = c.exame ? digitos(c.exame, 1, 9) : null;
  if (!especialidade && !exame) return invalido("especialidade_ou_exame");
  const hoje = ctx.hoje();
  let inicio = c.inicio ? dataIso(c.inicio) : hoje, fim = c.fim ? dataIso(c.fim) : null;
  if (!inicio || (c.fim && !fim)) return invalido("datas");
  if (inicio < hoje) inicio = hoje;
  if (!fim) fim = somarDias(inicio, 9);
  if (fim < inicio || diasEntre(inicio, fim) > MAX_DIAS) return invalido("periodo");
  const q: Record<string, string | number | undefined> = { inicio, fim };
  if (especialidade) q.especialidade = especialidade; else q.exame = exame!;
  if (c.plano) { const p = digitos(c.plano, 1, 9); if (!p) return invalido("plano"); q.plano = p; }
  for (const k of ["cnes", "crm", "subespecialidade", "classe_unidade"]) if (c[k]) { const t = curto(c[k], 40); if (!t) return invalido(k); q[k] = t; }
  if (c.revisao !== undefined) q.revisao = booleano(c.revisao) ? 1 : 0;
  if (c.telemed !== undefined) q.telemed = booleano(c.telemed) ? 1 : 0;
  if (c.id_regiao_cd) { const t = digitos(c.id_regiao_cd, 1, 9); if (!t) return invalido("id_regiao_cd"); q.id_regiao_cd = t; }
  try {
    const lista = await comCache<Horario[]>(ctx, "h:" + JSON.stringify(q), TTL_HORARIOS_MS, () => ctx.api.horarios(q));
    return ok({ total: lista.length, inicio, fim, horarios: lista });
  } catch (e) {
    // 403 em /agenda/horarios é regra de negócio (convênio sem médico, plano inativo ou inexistente): não é falha do sistema.
    if (e instanceof KlingoErro && (e.tipo === "sem_medico" || e.tipo === "plano_inativo" || e.tipo === "plano_desconhecido")) return ok({ total: 0, inicio, fim, horarios: [], motivo: e.tipo });
    return traduzir(e);
  }
}

async function catalogo(ctx: Ctx, c: Record<string, unknown>, nome: string): Promise<Resp> {
  try {
    if (nome === "convenio_cnpj") {
      const cnpj = digitos(c.cnpj, 14, 14);
      if (!cnpj) return invalido("cnpj");
      return ok({ dados: limparCatalogo(await comCache(ctx, "cnpj:" + cnpj, TTL_CATALOGO_MS, () => ctx.api.chamar("GET", `/convenio/${cnpj}`))) });
    }
    const def = CATALOGOS[nome];
    if (!def) return invalido("catalogo");
    const q = parametrosCatalogo(def, c);
    if ("status" in q) return q as Resp;
    return ok({ dados: limparCatalogo(await comCache(ctx, `c:${nome}:${JSON.stringify(q)}`, TTL_CATALOGO_MS, () => ctx.api.chamar("GET", def.caminho, { query: q }))) });
  } catch (e) { return traduzir(e); }
}

/** GET /requisicao: o token da requisição é o segredo (vem do pedido médico); o nome do paciente não é devolvido. */
async function requisicao(ctx: Ctx, c: Record<string, unknown>): Promise<Resp> {
  const id = digitos(c.id, 1, 12), origem = curto(c.origem, 30), token = curto(c.token, 120);
  if (!id) return invalido("id"); if (!origem) return invalido("origem"); if (!token) return invalido("token");
  try {
    const r = await ctx.api.chamar<Record<string, unknown>>("GET", "/requisicao", { query: { id, origem, token } });
    const q = ((r as { requisicao?: Record<string, unknown> })?.requisicao ?? r) as Record<string, unknown>;
    const { paciente: _p, ...resto } = q ?? {};
    return ok({ requisicao: limparCatalogo(resto) });
  } catch (e) { return traduzir(e); }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// B) Com identidade
// ---------------------------------------------------------------------------------------------------------------------------------------------
type Sessao = { token: string; id: string; tipo: "definitivo" | "pre"; user: Record<string, unknown>; cpf: string; nascimento: string };

const naoConfere = (): Resp => nega("nao_confere", { mensagem: "Não encontramos um cadastro com este CPF e esta data de nascimento." });

function lerIdentidade(c: Record<string, unknown>): { cpf: string; nascimento: string } | Resp {
  const cpf = cpfValido(c.cpf), nascimento = dataIso(c.nascimento);
  if (!cpf) return invalido("cpf");
  if (!nascimento) return invalido("nascimento");
  return { cpf, nascimento };
}

async function travado(ctx: Ctx, cpf: string): Promise<boolean> {
  return (await ctx.db.divergentesRecentes(await ctx.db.hash(cpf))) >= MAX_TENTATIVAS_CPF;
}
const travaResp = (): Resp => nega("tentativas_demais", { mensagem: "Muitas tentativas com este CPF. Tente de novo mais tarde ou procure a recepção." }, 429);

/** Confere o paciente no Klingo e abre a sessão dele. Devolve a sessão ou a resposta que explica por que parou (nunca segue com identidade duvidosa). */
async function abrirSessao(ctx: Ctx, cpf: string, nascimento: string): Promise<Sessao | Resp> {
  if (await travado(ctx, cpf)) return travaResp();
  let pac: Record<string, unknown> | null = null;
  try { pac = await ctx.api.pacientePorCpf(cpf) as Record<string, unknown> | null; } catch (e) {
    if (!(e instanceof KlingoErro && e.tipo === "paciente_nao_identificado")) return traduzir(e);
  }
  let idLogin: string | null = null, tipo: "definitivo" | "pre" = "definitivo";
  if (pac && pac.id !== undefined && pac.id !== null && pac.id !== "") {
    if (dataIso(pac.dt_nasc) !== nascimento) { await ctx.db.registrarIdentidade(cpf, nascimento, { situacao: "divergente" }); return naoConfere(); }
    const id = String(pac.id);
    if (!/^P\d+$/.test(id)) return nega("sem_cadastro_definitivo", { mensagem: "O cadastro precisa ser conferido pela recepção. Procure a clínica." });
    idLogin = id;
  } else {
    // quem só tem pré-cadastro não aparece na busca por CPF: o id fica guardado no nosso banco, ligado a CPF + nascimento
    const pre = await ctx.db.preDoPar(cpf, nascimento);
    if (!pre?.klingo_id || !/^\d+$/.test(pre.klingo_id)) return naoConfere();
    idLogin = pre.klingo_id; tipo = "pre";
  }
  try {
    const { token, user } = await ctx.api.login(idLogin);
    if (String(user.id ?? "") !== idLogin || dataIso(user.nascimento) !== nascimento) return nega("sessao_nao_confere", { mensagem: "Não foi possível confirmar o cadastro. Procure a recepção." });
    if (tipo === "pre" && user.id_paciente) return nega("sessao_nao_confere", { mensagem: "O cadastro mudou. Procure a recepção." });
    return { token, id: idLogin, tipo, user, cpf, nascimento };
  } catch (e) { return traduzir(e); }
}
const ehResp = (x: Sessao | Resp): x is Resp => "corpo" in x;

async function vouchersAtivos(ctx: Ctx, s: Sessao): Promise<Array<Record<string, unknown>>> {
  const l = await ctx.api.chamar<unknown>("GET", "/vouchers", { sessao: s.token });
  return Array.isArray(l) ? l as Array<Record<string, unknown>> : [];
}
const primeiroNome = (nome: unknown) => String(nome ?? "").trim().split(/\s+/)[0] || null;

type Marca = { horario: string; procedimento: string; plano: number; email: boolean; revisao: boolean; obs: string | null };
function lerMarca(c: Record<string, unknown>): Marca | Resp {
  const horario = String(c.horario ?? ""), procedimento = digitos(c.procedimento, 1, 9), plano = digitos(c.plano, 1, 9);
  if (!CHAVE_HORARIO.test(horario)) return invalido("horario");
  if (!procedimento) return invalido("procedimento");
  if (!plano) return invalido("plano");
  let obs: string | null = null;
  if (c.obs !== undefined && c.obs !== null && String(c.obs).trim() !== "") { obs = curto(c.obs, 160); if (!obs) return invalido("obs"); }
  return { horario, procedimento, plano: Number(plano), email: booleano(c.enviar_email), revisao: booleano(c.revisao), obs };
}
const corpoMarcacao = (m: Marca, idExterno: string) => ({
  id: m.horario, procedimento: m.procedimento, plano: m.plano, email: m.email, id_externo: idExterno,
  ...(m.revisao ? { revisao: true } : {}), obs: m.obs ? `Marcado pela página de agendamento. ${m.obs}` : "Marcado pela página de agendamento",
});

/** reservar (opcional) -> marcar. Se o resultado for incerto, reconcilia pelas marcações ativas (id_externo); se não achar, INCERTO. */
async function marcar(ctx: Ctx, s: Sessao, m: Marca, reservaId: string | null, remarcacao: string | null): Promise<Resp> {
  const idExterno = "pagina-" + ctx.uuid();
  const corpo = corpoMarcacao(m, idExterno);
  let reserva: string | null = reservaId;
  if (!reserva) {
    try { const r = await ctx.api.chamar<{ id?: number | string }>("POST", "/agenda/reservar", { sessao: s.token, corpo }); reserva = r?.id !== undefined ? String(r.id) : null; } catch (e) {
      if (e instanceof KlingoErro && e.tipo === "horario_ocupado") return nega("horario_ocupado", { mensagem: "Este horário acabou de ser ocupado. Escolha outro." });
      return traduzir(e);
    }
  }
  const soltar = async () => { if (reserva && !reservaId) await ctx.api.chamar("DELETE", "/agenda/reservar", { sessao: s.token, corpo: { id: Number(reserva) } }).catch(() => {}); };
  const reconciliar = async (): Promise<Resp | null> => {
    try { const a = (await vouchersAtivos(ctx, s)).map(resumoVoucher).find((v) => v.idExterno === idExterno); if (a?.id) return ok({ voucher: a, reconciliado: true }); } catch { /* segue incerto */ }
    return null;
  };
  try {
    const v = await ctx.api.chamar<Record<string, unknown>>("POST", "/agenda/horario", { sessao: s.token, corpo: { ...corpo, ...(remarcacao ? { remarcacao: Number(remarcacao) } : {}) }, timeoutMs: 25_000 });
    const voucher = resumoVoucher((v as { voucher?: Record<string, unknown> })?.voucher ?? v);
    if (!voucher.id) return (await reconciliar()) ?? nega("incerto", { mensagem: "Não conseguimos confirmar a marcação. Confira em “Minhas marcações” antes de tentar de novo." });
    return ok({ voucher });
  } catch (e) {
    if (e instanceof KlingoErro && e.tipo === "horario_ocupado") { await soltar(); return nega("horario_ocupado", { mensagem: "Este horário acabou de ser ocupado. Escolha outro." }); }
    if (e instanceof KlingoErro && !e.incerto) { await soltar(); return traduzir(e); }
    return (await reconciliar()) ?? nega("incerto", { mensagem: "Não conseguimos confirmar a marcação. Confira em “Minhas marcações” antes de tentar de novo." }, 502);
  }
}

const exigeConfirmacao = (c: Record<string, unknown>): Resp | null => c.confirmar === true ? null : nega("sem_confirmacao", { mensagem: "Ação não confirmada." }, 400);

/** Voucher que está entre as marcações ATIVAS da sessão do próprio paciente (ou a resposta que explica por que não). */
async function meuVoucher(ctx: Ctx, s: Sessao, c: Record<string, unknown>): Promise<{ id: string; lista: Array<Record<string, unknown>> } | Resp> {
  const id = digitos(c.voucher, 1, 12);
  if (!id) return invalido("voucher");
  const lista = await vouchersAtivos(ctx, s);
  if (!lista.some((v) => String(v.id) === id)) return nega("voucher_nao_encontrado", { mensagem: "Não achamos esta marcação entre as suas marcações ativas." });
  return { id, lista };
}
const ehMeu = (x: { id: string } | Resp): x is Resp => "corpo" in x;

async function cadastrar(ctx: Ctx, c: Record<string, unknown>): Promise<Resp> {
  const nome = curto(c.nome, 100, 5), sexo = String(c.sexo ?? "").toUpperCase(), cpf = cpfValido(c.cpf), nascimento = dataIso(c.nascimento);
  const celular = digitos(String(c.celular ?? "").replace(/\D/g, ""), 10, 11);
  const email = c.email ? curto(c.email, 120) : null, mae = c.mae ? curto(c.mae, 100, 3) : null;
  if (!nome || !/^\S+\s+\S+/.test(nome) || /[<>{}\\]/.test(nome)) return invalido("nome");
  if (sexo !== "M" && sexo !== "F") return invalido("sexo");
  if (!cpf) return invalido("cpf");
  if (!nascimento || nascimento > ctx.hoje() || nascimento < "1900-01-01") return invalido("nascimento");
  if (!celular) return invalido("celular");
  if (c.email && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return invalido("email");
  if (c.mae && (!mae || /[<>{}\\]/.test(mae))) return invalido("mae");
  if (c.confirmar !== true) return nega("sem_confirmacao", {}, 400);
  if (await travado(ctx, cpf)) return travaResp();
  if ((await ctx.db.precadastrosRecentes()) >= MAX_PRE_DIA) return nega("limite_diario", { mensagem: "Muitos cadastros hoje. Procure a recepção ou tente amanhã." }, 429);
  const generico = nega("nao_foi_possivel", { mensagem: "Não foi possível concluir o cadastro por aqui. Procure a recepção da clínica." });

  // 1) quem já tem cadastro definitivo não se cadastra de novo (e só quem prova o nascimento fica sabendo disso)
  try { const achado = await ctx.api.pacientePorCpf(cpf) as Record<string, unknown> | null;
    if (achado && achado.id !== undefined && achado.id !== null && achado.id !== "") {
      if (dataIso(achado.dt_nasc) === nascimento) return nega("ja_cadastrado", { mensagem: "Você já tem cadastro. Use “Entrar” com o CPF e a data de nascimento." });
      await ctx.db.registrarIdentidade(cpf, nascimento, { situacao: "divergente" });
      return generico;
    }
  } catch (e) { if (!(e instanceof KlingoErro && e.tipo === "paciente_nao_identificado")) return traduzir(e); }

  // 2) trava por CPF ANTES de registrar: a API do Klingo aceita registrar o mesmo CPF duas vezes
  const t = await ctx.db.reservarPre(cpf, nascimento);
  if (!t.criado) {
    if (t.mesmoPar && t.klingo_id) return nega("ja_cadastrado", { mensagem: "Você já tem um pré-cadastro. Use “Entrar” com o CPF e a data de nascimento." });
    if (t.mesmoPar) return nega("em_andamento", { mensagem: "Seu cadastro está sendo conferido. Procure a recepção se não puder continuar." });
    return generico;
  }
  try {
    const novo = await ctx.api.registrar({ nome, sexo, nascimento, cpf, celular, ...(email ? { email } : {}), ...(mae ? { mae } : {}) });
    await ctx.db.gravarPre(cpf, nascimento, novo.id);
    return ok({ tipo: "pre", primeiro_nome: primeiroNome(nome), mensagem: "Pré-cadastro feito. A recepção completa os seus dados." });
  } catch (e) {
    // resposta perdida: o pré-cadastro PODE ter sido criado. A marca fica (nunca registra de novo) e a equipe confere.
    if (e instanceof KlingoErro && e.incerto) return nega("incerto", { mensagem: "Não conseguimos confirmar o seu cadastro. Procure a recepção, por favor." }, 502);
    await ctx.db.soltarPre(cpf, nascimento);
    return traduzir(e);
  }
}

const lerContato = (c: Record<string, unknown>): { celular?: string; telefone?: string; email?: string } | Resp => {
  const o: { celular?: string; telefone?: string; email?: string } = {};
  if (c.celular !== undefined && c.celular !== "") { const d = digitos(String(c.celular).replace(/\D/g, ""), 10, 11); if (!d) return invalido("celular"); o.celular = d; }
  if (c.telefone !== undefined && c.telefone !== "") { const d = digitos(String(c.telefone).replace(/\D/g, ""), 8, 11); if (!d) return invalido("telefone"); o.telefone = d; }
  if (c.email !== undefined && c.email !== "") { const e = curto(c.email, 120); if (!e || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return invalido("email"); o.email = e; }
  return Object.keys(o).length ? o : invalido("nenhum_contato");
};

async function comIdentidade(ctx: Ctx, acao: string, c: Record<string, unknown>): Promise<Resp> {
  if (acao === "cadastrar") return await cadastrar(ctx, c);
  const idt = lerIdentidade(c);
  if ("status" in idt) return idt as Resp;
  const { cpf, nascimento } = idt;
  const s = await abrirSessao(ctx, cpf, nascimento);
  if (ehResp(s)) return s;
  try {
    switch (acao) {
      case "identificar": {
        if (s.tipo === "definitivo") await ctx.db.registrarIdentidade(cpf, nascimento, { situacao: "confere", klingo_id: s.id });
        const u = s.user, pl = (u.plano ?? {}) as Record<string, unknown>;
        return ok({ situacao: "confere", tipo: s.tipo, pre_cadastro: s.tipo === "pre", primeiro_nome: primeiroNome(u.nome), plano: pl.id !== undefined ? { id: Number(pl.id) || null, nome: pl.nome ?? null } : null });
      }
      case "meus_dados": {
        if (s.tipo === "pre") { const u = s.user; return ok({ pre_cadastro: true, dados: { nome: u.nome ?? null, nascimento: dataIso(u.nascimento) } }); }
        return ok({ pre_cadastro: false, dados: resumoCadastro(await ctx.api.chamar("GET", "/paciente", { sessao: s.token })) });
      }
      case "atualizar_contato": {
        const sem = exigeConfirmacao(c); if (sem) return sem;
        const ct = lerContato(c); if ("status" in ct) return ct as Resp;
        await ctx.api.chamar("PUT", "/paciente", { sessao: s.token, corpo: { paciente: { contatos: ct } } });
        return ok({ atualizado: Object.keys(ct) });
      }
      case "minhas_marcacoes": return ok({ marcacoes: (await vouchersAtivos(ctx, s)).map(resumoVoucher) });
      case "autorizacoes": return ok({ autorizacoes: limparCatalogo(await ctx.api.chamar("GET", "/autorizacoes", { sessao: s.token })) });
      case "reservar": {
        const m = lerMarca(c); if ("status" in m) return m as Resp;
        try {
          const r = await ctx.api.chamar<Record<string, unknown>>("POST", "/agenda/reservar", { sessao: s.token, corpo: corpoMarcacao(m, "pagina-" + ctx.uuid()) });
          const rv = ((r as { reserva?: Record<string, unknown> })?.reserva ?? r) as Record<string, unknown>;
          return ok({ reserva: { id: rv.id === undefined ? null : String(rv.id), expira: rv.expira ?? null, data: rv.data ?? null, hora: rv.hora ?? null, instrucao: limparCatalogo(rv.instrucao ?? null) } });
        } catch (e) { if (e instanceof KlingoErro && e.tipo === "horario_ocupado") return nega("horario_ocupado", { mensagem: "Este horário já está reservado ou ocupado." }); throw e; }
      }
      case "soltar": {
        const id = digitos(c.reserva, 1, 12); if (!id) return invalido("reserva");
        await ctx.api.chamar("DELETE", "/agenda/reservar", { sessao: s.token, corpo: { id: Number(id) } });
        return ok({ solto: true });
      }
      case "marcar": {
        const sem = exigeConfirmacao(c); if (sem) return sem;
        const m = lerMarca(c); if ("status" in m) return m as Resp;
        const reserva = c.reserva ? digitos(c.reserva, 1, 12) : null; if (c.reserva && !reserva) return invalido("reserva");
        return await marcar(ctx, s, m, reserva, null);
      }
      case "remarcar": {
        const sem = exigeConfirmacao(c); if (sem) return sem;
        const m = lerMarca(c); if ("status" in m) return m as Resp;
        const v = await meuVoucher(ctx, s, c); if (ehMeu(v)) return v;
        const reserva = c.reserva ? digitos(c.reserva, 1, 12) : null; if (c.reserva && !reserva) return invalido("reserva");
        return await marcar(ctx, s, m, reserva, v.id);
      }
      case "cancelar": {
        const sem = exigeConfirmacao(c); if (sem) return sem;
        const v = await meuVoucher(ctx, s, c); if (ehMeu(v)) return v;
        try { await ctx.api.chamar("DELETE", "/voucher", { sessao: s.token, corpo: { id: v.id } }); } catch (e) {
          if (e instanceof KlingoErro && e.tipo === "ja_cancelado") return ok({ cancelado: v.id, ja_estava: true });
          if (e instanceof KlingoErro && e.incerto) { // o Klingo pode ter cancelado: confere pela lista
            try { if (!(await vouchersAtivos(ctx, s)).some((x) => String(x.id) === v.id)) return ok({ cancelado: v.id, reconciliado: true }); } catch { /* continua incerto */ }
            return nega("incerto", { mensagem: "Não conseguimos confirmar o cancelamento. Veja “Minhas marcações”." }, 502);
          }
          throw e;
        }
        return ok({ cancelado: v.id });
      }
      case "trocar_procedimento": {
        const sem = exigeConfirmacao(c); if (sem) return sem;
        const proc = digitos(c.procedimento, 1, 9); if (!proc) return invalido("procedimento");
        const v = await meuVoucher(ctx, s, c); if (ehMeu(v)) return v;
        const r = await ctx.api.chamar<Record<string, unknown>>("PUT", "/agenda/procedimento", { sessao: s.token, corpo: { id_marcacao: Number(v.id), id_procedimento: Number(proc) } });
        return ok({ voucher: resumoVoucher(((r as { voucher?: Record<string, unknown> })?.voucher ?? r) as Record<string, unknown>) });
      }
      case "checkin": {
        const sem = exigeConfirmacao(c); if (sem) return sem;
        const v = await meuVoucher(ctx, s, c); if (ehMeu(v)) return v;
        const r = await ctx.api.chamar<Record<string, unknown>>("POST", "/checkin", { sessao: s.token, corpo: { id: Number(v.id), expresso: booleano(c.expresso), preferencial: booleano(c.preferencial) } });
        const ck = ((r as { checkinrealizado?: Record<string, unknown> })?.checkinrealizado ?? r) as Record<string, unknown>;
        return ok({ checkin: { local: ck.local ?? null, recepcao: ck.recepcao ?? null, preferencial: ck.preferencial ?? null, expresso: ck.expresso ?? null } });
      }
      case "cancelar_checkin": {
        const sem = exigeConfirmacao(c); if (sem) return sem;
        const v = await meuVoucher(ctx, s, c); if (ehMeu(v)) return v;
        await ctx.api.chamar("DELETE", "/checkin", { sessao: s.token, corpo: { id: Number(v.id) } });
        return ok({ checkin_cancelado: v.id });
      }
      case "resultado": {
        const v = await meuVoucher(ctx, s, c); if (ehMeu(v)) return v;
        const pdf = c.formato === "pdf";
        try {
          const r = await ctx.api.chamar<unknown>("GET", pdf ? `/resultado/pdf/${v.id}` : `/resultado/${v.id}`);
          const o = (typeof r === "object" && r ? r : { conteudo: r }) as Record<string, unknown>;
          // 'pronto' só vale se o Klingo disser que sim; o conteúdo não é guardado nem registrado em log
          const pronto = pdf ? true : o.pronto === true || o.pronto === 1 || o.pronto === "S";
          return ok({ pronto, status: o.status ?? null, formato: pdf ? "pdf" : "html", ...(pronto ? { resultado: o } : {}) });
        } catch (e) {
          // sem laudo, o Klingo responde 403 com uma página HTML (tratada como "html"/"outro"): isso é "ainda não tem resultado", não falha
          if (e instanceof KlingoErro && (e.tipo === "html" || e.status === 403)) return ok({ pronto: false, motivo: "sem_resultado" });
          throw e;
        }
      }
    }
  } catch (e) { return traduzir(e); }
  return nega("acao_invalida", {}, 400);
}

const ACOES_IDENTIDADE = new Set(["identificar", "meus_dados", "atualizar_contato", "minhas_marcacoes", "autorizacoes", "reservar", "soltar", "marcar", "remarcar", "cancelar", "trocar_procedimento", "checkin", "cancelar_checkin", "resultado", "cadastrar"]);

/** Ponto único de entrada: recebe o corpo JSON já lido e devolve status + corpo. */
export async function tratar(ctx: Ctx, c: Record<string, unknown>): Promise<Resp> {
  const acao = String(c?.acao ?? "");
  try {
    if (acao === "versao") return ok({ api: await ctx.api.versao() });
    if (acao === "horarios") return await horarios(ctx, c);
    if (acao === "catalogo") return await catalogo(ctx, c, String(c.catalogo ?? ""));
    if (acao === "requisicao") return await requisicao(ctx, c);
    if (acao === "resultado" && !ctx.resultado) return nega("desligado", { mensagem: "A entrega do resultado por aqui ainda não foi liberada pela clínica. Peça na recepção ou pelo chat." });
    if (ACOES_IDENTIDADE.has(acao)) return await comIdentidade(ctx, acao, c);
  } catch (e) { return traduzir(e); }
  return nega("acao_invalida", { acoes: ["versao", "horarios", "catalogo", "requisicao", ...ACOES_IDENTIDADE] }, 400);
}
