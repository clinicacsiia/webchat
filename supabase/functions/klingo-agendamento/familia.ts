// A família na página de agendamento: celular lembrado, pessoas (eu e os filhos), busca de horários ordenada, marcar todos juntos (tudo ou nada), acompanhamento tipo "rastreio" e laudo.
// Versão 1.0 — 13/11/2026 / Plano: docs/plano-jornada-familia.md. Sem Deno: o banco, o Klingo e a chave de cifra entram por parâmetro (os testes usam um Klingo de mentira e o banco de verdade, em memória).
//
// Ações (todas começam com "fam_"; o corpo é JSON {"acao": "...", "token": "<código do celular>", ...}):
//   fam_entrar        CPF + nascimento (uma vez) -> liga ESTE celular a quem entrou ("próprio") e devolve o código do celular (token). Só a partir daí nada mais é digitado.
//   fam_eu            quem este celular acompanha, avisos de acesso pendentes (não fala com o Klingo).
//   fam_dependente    acrescenta um filho (ou outra pessoa): sem CPF próprio, usa o CPF do responsável + o nascimento da criança (decisão do dono, 13/11/2026).
//   fam_buscar        horários do Klingo ORDENADOS (médico que a família já consultou, depois o mais procurado) e, para 2+ pessoas, combinações para marcar juntos. Lê do cache e enfileira a atualização.
//   fam_marcar        marca 1 a 4 pessoas: reserva todas, confirma todas; se uma falhar, solta/cancela as outras (tudo ou nada).
//   fam_acompanhar    linha do tempo de cada marcação (tipo Correios) + previsão do laudo que aprende; pede a leitura do Klingo para a rotina lenta.
//   fam_convidar / fam_convite_usar   outro responsável: código de 8 números, 15 min, uso único (sem digitar CPF).
//   fam_dados         "eu sei todos os dados" (CPF, nascimento, nome completo e celular do cadastro): abre a espera de 24 h com aviso aos outros celulares.
//   fam_aviso         quem já abre o laudo responde "Liberar" ou "Bloquear".
//   fam_cancelar / fam_checkin   "Não vou poder ir" (com a regra das 24 horas do chat; perto da hora a recepção resolve) e "Cheguei" (só no dia).
//   fam_marcar com `remarcar`   troca a marcação de UMA pessoa: a antiga só sai quando a nova está confirmada.
//   fam_espera_entrar / fam_espera_sair / fam_espera_responder   fila de espera por pressa (hoje, esta semana, qualquer dia mais cedo) e resposta à oferta de um horário que abriu.
//   fam_desligar      desliga ESTE celular.
//   fam_laudo         abre o laudo (só celular de nível 2 e só se AGENDAMENTO_RESULTADO=1: o laudo pronto de verdade ainda NÃO foi testado com o Klingo).
//   fam_sincronizar   (rotina do pg_cron, com FAMILIA_SYNC_CHAVE) lê a fila lenta: no máximo 3 leituras por minuto, só 1 se o Klingo reclamou.
//
// Regras que o código cumpre: CPF, nascimento, nome e celular só existem CIFRADOS no banco (cripto.ts); nada disso volta para a página; toda leitura do Klingo passa pela cota global;
// aparelho desligado ou parado há 12 meses não entra; nível 1 marca e acompanha, só nível 2 abre laudo; laudo nunca é guardado nem vai para log; cada abertura é registrada sem conteúdo.
import { cpfValido, dataIso, type Horario, KlingoErro, resumoVoucher } from "./api.ts";
import { cifrar, decifrar, novoToken, sha256 } from "./cripto.ts";
import { combinar, norm, ordenarMedicos, paraTela, primeiroLivre, slotLeve, type Contagem, type Slot } from "./ordenar.ts";
import { abrirSessaoCpf, corpoMarcacao, curto, digitos, ehResp, invalido, lerMarca, marcarComSessao, nega, ok, primeiroNome, somarDias, traduzir, tratar, vouchersAtivos, type Ctx, type Marca, type Resp, type Sessao } from "./regras.ts";

// ---------------------------------------------------------------------------------------------------------------------------------------------
// O que a função precisa do banco (supabase.rpc em produção; os testes ligam isto ao Postgres embutido)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type PessoaVista = { id: string; nome: string; papel: "proprio" | "responsavel"; porta: string; nivel: 1 | 2; espera_ate: string | null; plano_id: number | null; plano: string | null };
export type LeituraAparelho = { ok: boolean; motivo?: string; aparelho?: string; apelido?: string | null; pessoas?: PessoaVista[] };
export type PessoaLida = { id: string; primeiro_nome: string; dados_cifrados: string; cpf_de: string; klingo_id: string | null; plano_id: number | null; plano: string | null; papel: string; nivel: 1 | 2 };
export type Tarefa = { id: number; chave: string; params: Record<string, unknown> };
export type MarcacaoVista = { voucher: string; pessoa: string; nome: string; grupo: string | null; procedimento: string | null; profissional: string | null; unidade: string | null; data: string | null; hora: string | null;
  status: string; laudo_pronto_em: string | null; atualizado_em: string; eventos: Array<{ tipo: string; em: string }> };
export type FamiliaDb = {
  aparelhoCriar(tokenHash: string, apelido?: string | null): Promise<string>;
  aparelhoLer(tokenHash: string): Promise<LeituraAparelho>;
  aparelhoDesligar(aparelho: string): Promise<void>;
  pessoaGuardar(p: { chave: string; par_hash: string; primeiro_nome: string; dados_cifrados: string; cpf_de: string; klingo_id: string | null; plano_id: number | null; plano_nome: string | null }): Promise<{ id: string; novo: boolean }>;
  pessoaLer(aparelho: string, pessoa: string): Promise<PessoaLida | null>;
  pessoaLerServico(pessoa: string): Promise<{ id: string; primeiro_nome: string; dados_cifrados: string; klingo_id: string | null; plano_id: number | null } | null>;
  pessoasPorPar(parHash: string): Promise<Array<{ id: string; primeiro_nome: string; dados_cifrados: string; klingo_id: string | null }>>;
  pessoasNovasHoje(): Promise<number>;
  vincular(aparelho: string, pessoa: string, papel: string, porta: string, nivel?: number, liberadoEm?: string | null): Promise<{ ok: boolean; motivo?: string; limite?: number }>;
  conviteCriar(aparelho: string, pessoas: string[], codigoHash: string): Promise<{ ok: boolean; motivo?: string; expira_em?: string }>;
  conviteUsar(codigoHash: string, aparelho: string): Promise<{ ok: boolean; motivo?: string; ligadas?: number }>;
  pedirPorDados(aparelho: string, pessoa: string, papel: string): Promise<{ ok: boolean; motivo?: string; espera_ate?: string | null; imediato?: boolean }>;
  avisos(aparelho: string): Promise<Array<{ id: number; pessoa: string; desde: string }>>;
  avisoResponder(aparelho: string, aviso: number, liberar: boolean): Promise<{ ok: boolean; motivo?: string }>;
  marcacaoGravar(m: Record<string, unknown>): Promise<void>;
  acompanhar(aparelho: string): Promise<MarcacaoVista[]>;
  previsaoLaudo(procedimento: string): Promise<{ amostra: number; mediana_dias?: number; p80_dias?: number }>;
  historico(pessoas: string[]): Promise<Contagem>;
  popularidade(dias: number): Promise<Contagem>;
  pessoasAtivas(minutos: number): Promise<string[]>;
  marcacoesAbertas(pessoa: string): Promise<Array<{ voucher: string; status: string; data: string | null }>>;
  planosEmUso(): Promise<number[]>;
  config(): Promise<ConfigFamilia>;
  risco(aparelho: string): Promise<Risco>;
  alertar(tipo: string, aparelho: string | null, pessoa: string | null, detalhe?: Record<string, unknown>): Promise<void>;
  segurar(grupo: string, slots: SlotLivro[], segundos: number, estado?: string): Promise<{ ok: boolean; motivo?: string; indice?: number }>;
  segurarMarcar(grupo: string, segundos: number, vouchersPorChave?: Record<string, string>): Promise<void>;
  liberarVoucher(voucher: string): Promise<void>;
  soltar(grupo: string): Promise<void>;
  emUso(slots: SlotLivro[], ignorarGrupo?: string | null): Promise<string[]>;
  esperaEntrar(aparelho: string, pessoa: string, needKey: string, params: Record<string, unknown>, urgencia: string, voucher?: string | null, data?: string | null, hora?: string | null): Promise<{ ok: boolean; motivo?: string; id?: number; ja_estava?: boolean; limite?: number }>;
  esperaSair(aparelho: string, id: number): Promise<{ ok: boolean; motivo?: string }>;
  esperaListar(aparelho: string): Promise<EsperaVista[]>;
  esperaNecessidades(max: number): Promise<Array<{ need_key: string; params: Record<string, unknown> }>>;
  esperaLida(needKey: string): Promise<void>;
  esperaCandidatas(needKey: string): Promise<Candidata[]>;
  esperaOfertar(id: number, slot: Record<string, unknown>, segundos: number): Promise<{ ok: boolean; motivo?: string; grupo?: string }>;
  esperaExpirar(): Promise<{ ofertas_vencidas: number; esperas_vencidas: number }>;
  esperaResponder(aparelho: string, id: number, aceita: boolean): Promise<{ ok: boolean; motivo?: string; aceita?: boolean; espera?: { id: number; pessoa: string; params: Record<string, unknown>; oferta: Record<string, unknown>; grupo: string; voucher_atual: string | null } }>;
  esperaConcluir(id: number, voucher: string): Promise<void>;
  esperaFalhou(id: number): Promise<void>;
  acessoRegistrar(aparelho: string, pessoa: string, voucher: string): Promise<{ ok: boolean; motivo?: string }>;
  cacheLer(chave: string): Promise<{ dados: unknown; buscado_em: string; vencido: boolean } | null>;
  cacheGravar(chave: string, dados: unknown, validoSeg: number): Promise<void>;
  filaPedir(chave: string, params: Record<string, unknown>, prioridade: number): Promise<void>;
  filaPegar(max: number): Promise<Tarefa[]>;
  filaFim(id: number, ok: boolean, erro?: string | null, refazerSeg?: number | null): Promise<void>;
};
export type ConfigFamilia = { modo: string; cpfs: string[]; max_dependentes: number; max_marcacoes_familia: number; max_por_pessoa: number; oferta_min: number };
export type Risco = { dependentes_total: number; dependentes_24h: number; futuras_total: number; futuras_por_pessoa: Record<string, number>; cancelamentos_em_cima_60d: number; faltas_60d: number };
export type SlotLivro = { chave: string; inicio: string; profissional: string | null; unidade: string | null; minutos: number; pessoa?: string };
export type Candidata = { id: number; pessoa: string; urgencia: "hoje" | "semana" | "qualquer"; limite: string | null; voucher_atual: string | null; data_atual: string | null; hora_atual: string | null; recusadas: string[] };
export type EsperaVista = { id: number; pessoa: string; nome: string; necessidade: string | null; urgencia: string; estado: string; posicao: number; voucher_atual: string | null; data_atual: string | null; hora_atual: string | null; oferta: Record<string, unknown> | null; oferta_ate: string | null };
export type CtxFam = Ctx & { fam: { db: FamiliaDb | null; chave: string | null; chaveSync?: string | null } };

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------------------------------------------------------
const TOKEN = /^[A-Za-z0-9_-]{43}$/, CHAVE_HORARIO = /^\d{4}-\d{2}-\d{2}\|\d{1,9}\|\d{1,9}\|\d{1,9}\|\d{2}:\d{2}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PESSOAS_POR_VEZ = 4, MAX_DEPENDENTES_DIA = 40, TETO_FILA_POR_MINUTO = 3, CACHE_FRESCO_S = 90, CACHE_ACEITO_MS = 10 * 60_000;
const semChave = (): Resp => nega("desligado", { mensagem: "A área da família ainda não foi liberada pela clínica." }, 503);
const semAparelho = (motivo = "aparelho_desconhecido"): Resp => nega(motivo, { mensagem: motivo === "aparelho_dormindo" ? "Faz muito tempo que este celular não é usado. Entre de novo com o CPF e a data de nascimento." : "Este celular ainda não está ligado. Entre com o CPF e a data de nascimento." }, 401);
const ehResposta = (x: unknown): x is Resp => !!x && typeof x === "object" && "corpo" in (x as object);
const igual = (a: string, b: string) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const soDigitos = (v: unknown) => String(v ?? "").replace(/\D/g, "");

type Aparelho = { id: string; apelido: string | null; pessoas: PessoaVista[] };
async function aparelhoDe(ctx: CtxFam, c: Record<string, unknown>): Promise<Aparelho | Resp> {
  const t = String(c.token ?? "");
  if (!TOKEN.test(t)) return semAparelho();
  const r = await ctx.fam.db!.aparelhoLer(await sha256(t));
  if (!r.ok || !r.aparelho) return semAparelho(r.motivo === "dormindo" ? "aparelho_dormindo" : "aparelho_desconhecido");
  return { id: r.aparelho, apelido: r.apelido ?? null, pessoas: r.pessoas ?? [] };
}

type Pessoa = { id: string; primeiroNome: string; cpf: string; nascimento: string; nome: string; celular: string | null; sexo: string | null; klingoId: string | null; nivel: 1 | 2; papel: string; cpfDe: string; planoId: number | null; plano: string | null };
async function pessoaPlena(ctx: CtxFam, apId: string, pessoaId: string): Promise<Pessoa | null> {
  if (!UUID.test(pessoaId)) return null;
  const l = await ctx.fam.db!.pessoaLer(apId, pessoaId);
  if (!l) return null;
  const d = await decifrar<{ cpf: string; nascimento: string; nome: string; celular?: string; sexo?: string }>(l.dados_cifrados, ctx.fam.chave!);
  return { id: l.id, primeiroNome: l.primeiro_nome, cpf: d.cpf, nascimento: d.nascimento, nome: d.nome, celular: d.celular ?? null, sexo: d.sexo ?? null, klingoId: l.klingo_id, nivel: l.nivel, papel: l.papel, cpfDe: l.cpf_de, planoId: l.plano_id, plano: l.plano };
}

/** Abre a sessão de uma pessoa no Klingo. Com o id do Klingo guardado entra direto (1 chamada); sem ele, confere CPF + nascimento (2 chamadas). Sempre confere id e nascimento da sessão. */
async function sessaoDaPessoa(ctx: CtxFam, p: { cpf: string; nascimento: string; klingoId: string | null }): Promise<Sessao | Resp> {
  if (!p.klingoId) return await abrirSessaoCpf(ctx, p.cpf, p.nascimento);
  try {
    const { token, user } = await ctx.api.login(p.klingoId);
    if (String(user.id ?? "") !== p.klingoId || dataIso(user.nascimento) !== p.nascimento) return nega("sessao_nao_confere", { mensagem: "Não foi possível confirmar o cadastro. Procure a recepção." });
    return { token, id: p.klingoId, tipo: /^P\d+$/.test(p.klingoId) ? "definitivo" : "pre", user, cpf: p.cpf, nascimento: p.nascimento };
  } catch (e) { return traduzir(e); }
}

/** "MARIA TESTE" (como o Klingo guarda) vira "Maria" na tela: ninguém merece ser chamado aos gritos. */
export const nomeBonito = (nome: string | null | undefined) => { const p = String(nome ?? "").trim().split(/\s+/)[0] ?? ""; return p ? p.charAt(0).toLocaleUpperCase("pt-BR") + p.slice(1).toLocaleLowerCase("pt-BR") : "Paciente"; };

async function guardarPessoa(ctx: CtxFam, d: { cpf: string; nascimento: string; nome: string; celular?: string | null; sexo?: string | null; cpfDe: "proprio" | "responsavel"; klingoId: string | null; planoId: number | null; planoNome: string | null }) {
  const chave = await ctx.db.hash(`${d.cpf}|${d.nascimento}|${norm(d.nome)}`), par = await ctx.db.hash(`${d.cpf}|${d.nascimento}`);
  const cifrado = await cifrar({ cpf: d.cpf, nascimento: d.nascimento, nome: d.nome, ...(d.celular ? { celular: d.celular } : {}), ...(d.sexo ? { sexo: d.sexo } : {}) }, ctx.fam.chave!);
  return await ctx.fam.db!.pessoaGuardar({ chave, par_hash: par, primeiro_nome: nomeBonito(d.nome).slice(0, 40), dados_cifrados: cifrado, cpf_de: d.cpfDe, klingo_id: d.klingoId, plano_id: d.planoId, plano_nome: d.planoNome });
}
const planoDe = (user: Record<string, unknown>) => { const pl = (user.plano ?? {}) as Record<string, unknown>; const id = Number(pl.id); return { id: Number.isInteger(id) && id > 0 ? id : null, nome: pl.nome ? String(pl.nome).slice(0, 80) : null }; };

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Entrar, quem sou eu, filhos, desligar
// ---------------------------------------------------------------------------------------------------------------------------------------------
/** O aparelho do pedido (se o código ainda vale) ou um aparelho novo. Devolve o código novo SÓ quando criou. */
async function aparelhoOuNovo(ctx: CtxFam, c: Record<string, unknown>): Promise<{ id: string; tokenNovo: string | null } | Resp> {
  if (c.token) { const a = await aparelhoDe(ctx, c); if (!ehResposta(a)) return { id: a.id, tokenNovo: null }; }
  const token = novoToken();
  return { id: await ctx.fam.db!.aparelhoCriar(await sha256(token), curto(c.apelido, 40)), tokenNovo: token };
}
/** As pessoas que o celular acompanha agora (relê do banco, já com a ligação que acabou de ser feita). */
async function pessoasDoAparelho(ctx: CtxFam, c: Record<string, unknown>, tokenNovo: string | null, _apId: string): Promise<PessoaVista[]> {
  return (await ctx.fam.db!.aparelhoLer(await sha256(tokenNovo ?? String(c.token ?? "")))).pessoas ?? [];
}

async function entrar(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const cpf = cpfValido(c.cpf), nascimento = dataIso(c.nascimento);
  if (!cpf) return invalido("cpf");
  if (!nascimento) return invalido("nascimento");
  const s = await abrirSessaoCpf(ctx, cpf, nascimento);
  if (ehResp(s)) return s;
  if (s.tipo === "definitivo") await ctx.db.registrarIdentidade(cpf, nascimento, { situacao: "confere", klingo_id: s.id });
  const pl = planoDe(s.user);
  const pessoa = await guardarPessoa(ctx, { cpf, nascimento, nome: String(s.user.nome ?? "Paciente").trim() || "Paciente", cpfDe: "proprio", klingoId: s.id, planoId: pl.id, planoNome: pl.nome });
  const ap = await aparelhoOuNovo(ctx, c);
  if (ehResposta(ap)) return ap;
  const v = await ctx.fam.db!.vincular(ap.id, pessoa.id, "proprio", "cpf", 1);
  if (!v.ok) return v.motivo === "limite_aparelhos" ? nega("limite_aparelhos", { mensagem: `Este cadastro já está em ${v.limite ?? 3} celulares. Peça a um deles para dar acesso, ou procure a recepção.` }) : nega(v.motivo ?? "erro");
  return ok({ ...(ap.tokenNovo ? { token: ap.tokenNovo } : {}), pessoas: await pessoasDoAparelho(ctx, c, ap.tokenNovo, ap.id) });
}

async function eu(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  return ok({ apelido: ap.apelido, pessoas: ap.pessoas, avisos: await ctx.fam.db!.avisos(ap.id), espera: await ctx.fam.db!.esperaListar(ap.id) });
}

async function celularDaFamilia(ctx: CtxFam, ap: Aparelho): Promise<string | null> {
  for (const p of ap.pessoas) { const x = await pessoaPlena(ctx, ap.id, p.id); if (x?.celular) return x.celular; }
  return null;
}

/** Filho (ou outra pessoa): se não tem CPF, o CPF do responsável + o nascimento dele identificam o cadastro. O Klingo não acha esta criança por CPF (a busca devolve um paciente só):
 *  por isso o id do pré-cadastro fica guardado e o login é sempre por id. NÃO TESTADO com o Klingo real (registrar com o CPF de um paciente que já existe). */
async function dependente(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  const nome = curto(c.nome, 100, 5), sexo = String(c.sexo ?? "").toUpperCase(), nascimento = dataIso(c.nascimento), cpfProprio = c.cpf ? cpfValido(c.cpf) : null;
  if (!nome || !/^\S+\s+\S+/.test(nome) || /[<>{}\\]/.test(nome)) return invalido("nome");
  if (sexo !== "M" && sexo !== "F") return invalido("sexo");
  if (!nascimento || nascimento > ctx.hoje() || nascimento < "1900-01-01") return invalido("nascimento");
  if (c.cpf && !cpfProprio) return invalido("cpf");
  let celular = c.celular ? digitos(soDigitos(c.celular), 10, 11) : null;
  if (c.celular && !celular) return invalido("celular");
  let cpfUsado = cpfProprio, cpfDe: "proprio" | "responsavel" = "proprio";
  if (!cpfUsado) {
    const resp = ap.pessoas.find((p) => p.papel === "proprio");
    const r = resp ? await pessoaPlena(ctx, ap.id, resp.id) : null;
    if (!r) return nega("responsavel_necessario", { mensagem: "Entre primeiro com o seu CPF para cadastrar o seu filho." });
    cpfUsado = r.cpf; cpfDe = "responsavel";
  }
  celular = celular ?? await celularDaFamilia(ctx, ap);
  // cuidado com quem acrescenta pessoas demais (ou depressa demais): não é acusação, a recepção confere junto e a equipe vê um alerta
  const [cfg, risco] = await Promise.all([ctx.fam.db!.config(), ctx.fam.db!.risco(ap.id)]);
  if (risco.dependentes_total >= cfg.max_dependentes || risco.dependentes_24h >= 3) {
    await ctx.fam.db!.alertar("muitos_dependentes", ap.id, null, { total: risco.dependentes_total, em_24h: risco.dependentes_24h, limite: cfg.max_dependentes });
    return nega("limite_pessoas", { mensagem: "Para cadastrar mais pessoas, a recepção confere junto com você. É só para a segurança de todos." });
  }

  // já existe (outro responsável cadastrou antes)? então só liga este celular
  const par = await ctx.db.hash(`${cpfUsado}|${nascimento}`), existentes = await ctx.fam.db!.pessoasPorPar(par);
  for (const e of existentes) {
    const d = await decifrar<{ nome: string }>(e.dados_cifrados, ctx.fam.chave!);
    if (norm(d.nome) === norm(nome) && e.klingo_id) {
      const v = await ctx.fam.db!.vincular(ap.id, e.id, "responsavel", "cpf", 1);
      if (!v.ok) return nega(v.motivo ?? "erro", { limite: v.limite });
      return ok({ ja_existia: true, pessoas: await pessoasDoAparelho(ctx, c, null, ap.id) });
    }
  }

  let klingoId: string | null = null;
  if (cpfProprio) {                           // CPF próprio: se já existe no Klingo com este nascimento, usa o cadastro que existe
    try {
      const achado = await ctx.api.pacientePorCpf(cpfProprio) as Record<string, unknown> | null;
      if (achado && achado.id !== undefined && achado.id !== null && achado.id !== "") {
        if (dataIso(achado.dt_nasc) !== nascimento || !/^P\d+$/.test(String(achado.id))) return nega("nao_foi_possivel", { mensagem: "Não foi possível concluir por aqui. Procure a recepção da clínica." });
        klingoId = String(achado.id);
      }
    } catch (e) { if (!(e instanceof KlingoErro && e.tipo === "paciente_nao_identificado")) return traduzir(e); }
  }
  if (!klingoId) {
    if (!celular) return nega("celular_necessario", { mensagem: "Precisamos de um celular com DDD para o cadastro." });
    if ((await ctx.fam.db!.pessoasNovasHoje()) >= MAX_DEPENDENTES_DIA) return nega("limite_diario", { mensagem: "Muitos cadastros hoje. Procure a recepção ou tente amanhã." }, 429);
    // trava antes de registrar (a API aceita duplicar): a linha da pessoa nasce sem id do Klingo; se a resposta se perder, ela fica e a recepção confere
    const marca = await guardarPessoa(ctx, { cpf: cpfUsado!, nascimento, nome, celular, sexo, cpfDe, klingoId: null, planoId: null, planoNome: null });
    if (!marca.novo) return nega("em_andamento", { mensagem: "O cadastro está sendo conferido. Procure a recepção se não puder continuar." });
    try { klingoId = (await ctx.api.registrar({ nome, sexo, nascimento, cpf: cpfUsado!, celular })).id; } catch (e) {
      if (e instanceof KlingoErro && e.incerto) return nega("incerto", { mensagem: "Não conseguimos confirmar o cadastro. Procure a recepção, por favor." }, 502);
      throw e;
    }
  }
  const s = await sessaoDaPessoa(ctx, { cpf: cpfUsado!, nascimento, klingoId });
  if (ehResp(s)) return s;
  const pl = planoDe(s.user);
  const pessoa = await guardarPessoa(ctx, { cpf: cpfUsado!, nascimento, nome, celular, sexo, cpfDe, klingoId, planoId: pl.id, planoNome: pl.nome });
  const v = await ctx.fam.db!.vincular(ap.id, pessoa.id, "responsavel", "cpf", 1);
  if (!v.ok) return nega(v.motivo ?? "erro", { limite: v.limite });
  return ok({ pessoas: await pessoasDoAparelho(ctx, c, null, ap.id) });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Buscar horários (ordenados) e marcar (tudo ou nada)
// ---------------------------------------------------------------------------------------------------------------------------------------------
async function lerPessoasDoPedido(ctx: CtxFam, ap: Aparelho, c: Record<string, unknown>): Promise<Pessoa[] | Resp> {
  const ids = Array.isArray(c.pessoas) ? c.pessoas.map(String) : [];
  if (!ids.length || ids.length > MAX_PESSOAS_POR_VEZ || new Set(ids).size !== ids.length) return invalido("pessoas");
  const saida: Pessoa[] = [];
  for (const id of ids) { const p = await pessoaPlena(ctx, ap.id, id); if (!p) return nega("pessoa_nao_encontrada", { mensagem: "Esta pessoa não está ligada a este celular." }, 403); saida.push(p); }
  return saida;
}

/** A chave do cache de horários: a mesma na busca da página e na pré-carga lenta. */
export const chaveHorarios = (q: Record<string, string>) => "h:" + Object.entries(q).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");

async function horariosDoCache(ctx: CtxFam, q: Record<string, string>): Promise<{ lista: Horario[]; atualizadoEm: string; desatualizado: boolean; motivo?: string }> {
  const chave = chaveHorarios(q);
  const db = ctx.fam.db!, c = await db.cacheLer(chave);
  if (c && Array.isArray(c.dados) && (!c.vencido || ctx.agora() - Date.parse(c.buscado_em) < CACHE_ACEITO_MS)) {
    if (c.vencido) await db.filaPedir(chave, { tipo: "horarios", q }, 3);       // mostra o que tem agora e manda atualizar (a rotina lenta cuida)
    return { lista: c.dados as Horario[], atualizadoEm: c.buscado_em, desatualizado: c.vencido };
  }
  try {
    const lista = await ctx.api.horarios(q);
    await db.cacheGravar(chave, lista, CACHE_FRESCO_S);
    return { lista, atualizadoEm: new Date(ctx.agora()).toISOString(), desatualizado: false };
  } catch (e) {
    if (e instanceof KlingoErro && (e.tipo === "sem_medico" || e.tipo === "plano_inativo" || e.tipo === "plano_desconhecido")) return { lista: [], atualizadoEm: new Date(ctx.agora()).toISOString(), desatualizado: false, motivo: e.tipo };
    throw e;
  }
}

async function buscar(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  const ps = await lerPessoasDoPedido(ctx, ap, c);
  if (ehResposta(ps)) return ps;
  const especialidade = c.especialidade ? curto(c.especialidade, 20) : null, exame = c.exame ? digitos(c.exame, 1, 9) : null;
  if (!especialidade && !exame) return invalido("especialidade_ou_exame");
  const plano = String(ps[0].planoId ?? 1), planosDiferentes = new Set(ps.map((p) => p.planoId ?? 1)).size > 1;
  const hoje = ctx.hoje(), inicio = hoje;
  let dias = 9, r = await horariosDoCache(ctx, { inicio, fim: somarDias(inicio, dias), plano, ...(especialidade ? { especialidade } : { exame: exame! }) });
  let lista = await tirarIndisponiveis(ctx, r.lista, null);                      // fora: o que outra pessoa já segura (página ou chat) e o que começa em menos de 30 minutos
  if (!lista.length && !r.motivo) { dias = 30; r = await horariosDoCache(ctx, { inicio, fim: somarDias(inicio, dias), plano, ...(especialidade ? { especialidade } : { exame: exame! }) }); lista = await tirarIndisponiveis(ctx, r.lista, null); }   // vazio? amplia sozinho
  const [historico, procura] = await Promise.all([ctx.fam.db!.historico(ps.map((p) => p.id)), popularidade(ctx)]);
  const medicos = ordenarMedicos(lista, historico, procura);
  return ok({
    total: lista.length, janela: { inicio, fim: somarDias(inicio, dias) }, atualizado_em: r.atualizadoEm, desatualizado: r.desatualizado, ...(r.motivo ? { motivo: r.motivo } : {}), ...(planosDiferentes ? { aviso: "planos_diferentes" } : {}),
    primeiro: primeiroLivre(medicos), medicos: medicos.map(paraTela), combinacoes: combinar(medicos, ps.length), pessoas: ps.map((p) => ({ id: p.id, nome: p.primeiroNome })),
  });
}
async function popularidade(ctx: CtxFam): Promise<Contagem> {
  const c = ctx.cache.get("popularidade");
  if (c && c.ate > ctx.agora()) return c.v as Contagem;
  const v = await ctx.fam.db!.popularidade(90).catch(() => [] as Contagem);
  ctx.cache.set("popularidade", { ate: ctx.agora() + 600_000, v });
  return v;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Marcar com CERTEZA: o horário só é marcado se estiver livre NESTE instante
// ---------------------------------------------------------------------------------------------------------------------------------------------
// A ordem dos passos é de propósito (cada um protege o paciente de um problema que só aparece depois):
//   1. chave de segurança (modo "teste" só deixa os CPFs liberados marcarem; "desligado" para tudo) e limites de abuso (celular que junta marcações demais);
//   2. o horário é conferido AO VIVO no Klingo (a lista da tela pode ter minutos de idade): se não estiver lá, a pessoa escolhe outro, com 3 alternativas já prontas;
//   3. a pessoa não pode ter outra marcação ativa no mesmo horário nem a mesma consulta/exame duas vezes (quem junta horários atrapalha quem espera);
//   4. o LIVRO-CAIXA (banco) segura o horário para ela: dois pedidos no mesmo milissegundo, pela página ou pelo chat, e só UM ganha; o outro é avisado na hora;
//   5. o Klingo reserva e marca (o juiz final); se algo falhar no meio, solta e desfaz tudo (tudo ou nada);
//   6. depois de marcar, confere que o Klingo gravou o dia e a hora PEDIDOS; se não for igual, desfaz e avisa.
const ANTECEDENCIA_MIN = 30, SEGURAR_S = 600, MIN_SLOT = 30;
type Necessidade = { especialidade?: string; exame?: string; nome: string };
type Item = { pessoa: Pessoa; sessao: Sessao; marca: Marca; reserva: string | null; idExterno: string; remarcar: string | null; slot: Horario; hint: { medico: string | null; unidade: string | null } };
const minutosDoDia = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const slotLivro = (h: Horario, pessoa?: string): SlotLivro => ({ chave: h.id, inicio: `${h.data}T${h.hora}`, profissional: h.profissional?.nome ?? null, unidade: h.unidade?.nome ?? null, minutos: MIN_SLOT, ...(pessoa ? { pessoa } : {}) });
const comecaEm = (h: { data: string; hora: string }) => Date.parse(`${h.data}T${h.hora.slice(0, 5)}:00-03:00`);
const soltarReserva = async (ctx: CtxFam, it: Item) => { if (it.reserva) await ctx.api.chamar("DELETE", "/agenda/reservar", { sessao: it.sessao.token, corpo: { id: Number(it.reserva) } }).catch(() => {}); };
const desfazer = async (ctx: CtxFam, feitos: Array<{ it: Item; voucher: { id: string | null } }>) => {
  const desfeitas: string[] = [], presas: string[] = [];
  for (const f of feitos) { try { await ctx.api.chamar("DELETE", "/voucher", { sessao: f.it.sessao.token, corpo: { id: f.voucher.id } }); desfeitas.push(f.it.pessoa.primeiroNome); } catch { presas.push(f.it.pessoa.primeiroNome); } }
  return { desfeitas, presas };
};

function lerNecessidade(c: unknown): Necessidade | Resp {
  const n = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
  const especialidade = n.especialidade ? curto(n.especialidade, 20) : null, exame = n.exame ? digitos(n.exame, 1, 9) : null, nome = curto(n.nome, 80) ?? (especialidade ? "Consulta" : "Exame");
  if (!especialidade && !exame) return invalido("necessidade");
  return { ...(especialidade ? { especialidade } : { exame: exame! }), nome };
}
const chaveNecessidade = (n: Necessidade, plano: number | string) => `${n.especialidade ? "especialidade=" + n.especialidade : "exame=" + n.exame}&plano=${plano}`;
const consultaDe = (n: Necessidade, plano: number | string, inicio: string, fim: string): Record<string, string> => ({ inicio, fim, plano: String(plano), ...(n.especialidade ? { especialidade: n.especialidade } : { exame: n.exame! }) });

/** Horários livres AGORA (ao vivo, sem cache) a partir de hoje, com os que começam em menos de 30 minutos e os que outra pessoa já segura (livro-caixa ou chat) já tirados. */
async function listaAoVivo(ctx: CtxFam, n: Necessidade, plano: number | string, ateData: string, ignorarGrupo: string | null): Promise<Horario[]> {
  const hoje = ctx.hoje(), fim = ateData > somarDias(hoje, 9) ? (ateData > somarDias(hoje, 30) ? somarDias(hoje, 30) : ateData) : somarDias(hoje, 9), q = consultaDe(n, plano, hoje, fim);
  let lista: Horario[];
  try { lista = await ctx.api.horarios(q); } catch (e) { if (e instanceof KlingoErro && (e.tipo === "sem_medico" || e.tipo === "plano_inativo" || e.tipo === "plano_desconhecido")) return []; throw e; }
  await ctx.fam.db!.cacheGravar(chaveHorarios(q), lista, CACHE_FRESCO_S);
  return await tirarIndisponiveis(ctx, lista, ignorarGrupo);
}
async function tirarIndisponiveis(ctx: CtxFam, lista: Horario[], ignorarGrupo: string | null): Promise<Horario[]> {
  const limite = ctx.agora() + ANTECEDENCIA_MIN * 60_000, futuros = lista.filter((h) => comecaEm(h) >= limite);
  if (!futuros.length) return [];
  const usados = new Set(await ctx.fam.db!.emUso(futuros.map((h) => slotLivro(h)), ignorarGrupo));
  return futuros.filter((h) => !usados.has(h.id));
}
/** Até 3 horários livres parecidos com o que a pessoa queria: o mesmo médico no mesmo dia, depois o mesmo médico em outro dia, depois qualquer médico, sempre os mais próximos do pedido. */
export function alternativas(lista: Horario[], queria: { data: string; hora: string; medico: string | null }, evitar: Set<string>, k = 3): Slot[] {
  const alvo = comecaEm(queria);
  const peso = (h: Horario) => { const mesmoMedico = h.profissional?.nome === queria.medico, mesmoDia = h.data === queria.data; return (mesmoMedico && mesmoDia ? 0 : mesmoMedico ? 1 : 2) * 1e13 + Math.abs(comecaEm(h) - alvo); };
  return lista.filter((h) => !evitar.has(h.id)).sort((a, b) => peso(a) - peso(b)).slice(0, k).map(slotLeve);
}

async function executarMarcacao(ctx: CtxFam, ap: Aparelho, itens: Array<Record<string, unknown>>, nec: Necessidade, opc: { grupoFixo?: string } = {}): Promise<Resp> {
  const db = ctx.fam.db!, grupo = opc.grupoFixo ?? ctx.uuid(), hoje = ctx.hoje();
  const pessoas: Pessoa[] = [];
  for (const it of itens) {
    const p = await pessoaPlena(ctx, ap.id, String(it.pessoa ?? ""));
    if (!p) return nega("pessoa_nao_encontrada", { mensagem: "Esta pessoa não está ligada a este celular." }, 403);
    if (!CHAVE_HORARIO.test(String(it.horario ?? ""))) return invalido("horario");
    pessoas.push(p);
  }
  const remarcando = itens.some((i) => i.remarcar !== undefined && i.remarcar !== null && i.remarcar !== "");
  // 1) chave de segurança e limites de abuso
  const cfg = await db.config();
  if (cfg.modo === "desligado") return nega("desligado", { mensagem: "A marcação por aqui está pausada agora. Fale com a recepção." }, 503);
  if (cfg.modo === "teste" && !pessoas.every((p) => cfg.cpfs.includes(p.cpf))) return nega("em_teste", { mensagem: "A marcação por aqui ainda está em fase de testes. A recepção ou o chat marcam para você agora mesmo." }, 403);
  if (!remarcando) {
    const r = await db.risco(ap.id);
    if (r.futuras_total + itens.length > cfg.max_marcacoes_familia) { await db.alertar("muitas_marcacoes", ap.id, pessoas[0].id, { futuras: r.futuras_total, pedidas: itens.length }); return nega("muitas_marcacoes", { mensagem: "Você já tem muitas marcações por vir. Para marcar mais, fale com a recepção: eles organizam junto com você." }); }
    for (const p of pessoas) if ((r.futuras_por_pessoa[p.id] ?? 0) >= cfg.max_por_pessoa) { await db.alertar("muitas_marcacoes_pessoa", ap.id, p.id, { futuras: r.futuras_por_pessoa[p.id] }); return nega("muitas_marcacoes_pessoa", { pessoa: p.primeiroNome, mensagem: `${p.primeiroNome} já tem ${r.futuras_por_pessoa[p.id]} marcações por vir. Para marcar outra, fale com a recepção.` }); }
  }
  // 2) o horário é conferido AO VIVO (por plano) e fica com os dados do Klingo, nunca com os que a tela mandou
  const porPlano = new Map<string, Horario[]>(), escolhidos: Horario[] = [];
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i], p = pessoas[i], plano = String(it.plano ?? p.planoId ?? 1), ate = String(it.horario).slice(0, 10);
    if (!porPlano.has(plano)) porPlano.set(plano, await listaAoVivo(ctx, nec, plano, ate, grupo));
    else if (ate > (porPlano.get(plano)!.at(-1)?.data ?? ate)) porPlano.set(plano, await listaAoVivo(ctx, nec, plano, ate, grupo));
    const achado = porPlano.get(plano)!.find((h) => h.id === it.horario);
    if (!achado) {
      const queria = { data: String(it.horario).slice(0, 10), hora: String(it.horario).slice(-5), medico: curto(it.medico, 80) };
      const evitar = new Set(itens.map((x) => String(x.horario)));
      return nega("horario_ocupado", { indice: i, pessoa: p.primeiroNome, mensagem: "Esse horário acabou de ser ocupado. Já separamos outros para você.", alternativas: alternativas(porPlano.get(plano)!, queria, evitar) });
    }
    escolhidos.push(achado);
  }
  // sessões e conferência das marcações que a pessoa JÁ tem (duplicidade e horário cruzado)
  const prontos: Item[] = [];
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i], p = pessoas[i], slot = escolhidos[i];
    const marca = lerMarca({ horario: it.horario, procedimento: it.procedimento, plano: it.plano ?? p.planoId ?? 1, obs: it.obs });
    if ("status" in marca) return marca as Resp;
    const s = await sessaoDaPessoa(ctx, p);
    if (ehResp(s)) return s;
    let remarcar: string | null = null;
    if (it.remarcar !== undefined && it.remarcar !== null && it.remarcar !== "") { remarcar = digitos(it.remarcar, 1, 12); if (!remarcar || itens.length !== 1) return invalido("remarcar"); }
    const ativos = (await vouchersAtivos(ctx, s)).map(resumoVoucher);
    if (remarcar && !ativos.some((v) => v.id === remarcar)) return nega("voucher_nao_encontrado", { mensagem: "Não achamos esta marcação entre as suas marcações ativas." });
    for (const v of ativos) {
      if (v.id === remarcar || !v.data) continue;
      if (v.procedimento_id === String(marca.procedimento) && v.data >= hoje) return nega("ja_tem_marcacao", { pessoa: p.primeiroNome, existente: { voucher: v.id, data: v.data, hora: v.hora, procedimento: v.procedimento }, mensagem: `${p.primeiroNome} já tem este atendimento marcado. Se precisar de outro dia, use "Mudar o horário".` });
      if (v.data === slot.data && v.hora && Math.abs(minutosDoDia(v.hora) - minutosDoDia(slot.hora)) < MIN_SLOT) return nega("conflito_horario", { pessoa: p.primeiroNome, existente: { voucher: v.id, data: v.data, hora: v.hora, procedimento: v.procedimento }, mensagem: `${p.primeiroNome} já tem outro atendimento nesse horário. Escolha um horário diferente.` });
    }
    prontos.push({ pessoa: p, sessao: s, marca, reserva: null, idExterno: `pagina-${grupo}-${i}`, remarcar, slot, hint: { medico: curto(it.medico, 80), unidade: curto(it.unidade, 80) } });
  }
  // 4) livro-caixa: um só ganha, no mesmo instante
  const livro = await db.segurar(grupo, prontos.map((x) => slotLivro(x.slot, x.pessoa.id)), SEGURAR_S);
  if (!livro.ok) {
    const i = livro.indice ?? 0, evitar = new Set(prontos.map((x) => x.slot.id));
    if (livro.motivo === "pessoa_ocupada") return nega("conflito_horario", { indice: i, pessoa: prontos[i].pessoa.primeiroNome, mensagem: `${prontos[i].pessoa.primeiroNome} já está com outro horário em andamento nesse mesmo momento. Termine ou espere alguns minutos.` });
    const lista = await tirarIndisponiveis(ctx, porPlano.get(String(itens[i].plano ?? pessoas[i].planoId ?? 1)) ?? [], grupo);
    return nega("horario_ocupado", { indice: i, pessoa: prontos[i].pessoa.primeiroNome, mensagem: "Outra pessoa acabou de escolher esse horário. Já separamos outros para você.", alternativas: alternativas(lista, { data: prontos[i].slot.data, hora: prontos[i].slot.hora, medico: prontos[i].slot.profissional?.nome ?? null }, evitar) });
  }
  const falhar = async (r: Resp, extras: Record<string, unknown> = {}): Promise<Resp> => { await db.soltar(grupo); return { status: r.status, corpo: { ...r.corpo, ...extras } }; };
  // 5) o Klingo reserva e marca; tudo ou nada
  for (let i = 0; i < prontos.length; i++) {
    const it = prontos[i];
    try {
      const r = await ctx.api.chamar<Record<string, unknown>>("POST", "/agenda/reservar", { sessao: it.sessao.token, corpo: corpoMarcacao(it.marca, it.idExterno) });
      const rv = ((r as { reserva?: Record<string, unknown> })?.reserva ?? r) as Record<string, unknown>;
      it.reserva = rv?.id !== undefined && rv?.id !== null ? String(rv.id) : null;
    } catch (e) {
      for (const x of prontos) await soltarReserva(ctx, x);
      if (e instanceof KlingoErro && e.tipo === "horario_ocupado") {
        const lista = await tirarIndisponiveis(ctx, porPlano.get(String(itens[i].plano ?? pessoas[i].planoId ?? 1)) ?? [], grupo).catch(() => []);
        return await falhar(nega("horario_ocupado", { indice: i, pessoa: it.pessoa.primeiroNome, mensagem: "Um dos horários acabou de ser ocupado. Já separamos outros para você." }), { alternativas: alternativas(lista, { data: it.slot.data, hora: it.slot.hora, medico: it.slot.profissional?.nome ?? null }, new Set([it.slot.id])) });
      }
      return await falhar(traduzir(e));
    }
  }
  const feitos: Array<{ it: Item; voucher: ReturnType<typeof resumoVoucher> }> = [];
  for (const it of prontos) {
    const r = await marcarComSessao(ctx, it.sessao, it.marca, it.reserva, it.remarcar, it.idExterno);
    const voucher = (r.corpo as { voucher?: ReturnType<typeof resumoVoucher> }).voucher;
    if (r.corpo.ok === true && voucher?.id) {
      // 6) o Klingo gravou o que foi pedido? Se a data ou a hora forem outras, desfaz tudo e avisa (nunca deixa uma marcação "quase certa")
      if (voucher.data !== it.slot.data || (voucher.hora ?? "").slice(0, 5) !== it.slot.hora.slice(0, 5)) {
        await db.alertar("divergencia_marcacao", ap.id, it.pessoa.id, { pedido: `${it.slot.data} ${it.slot.hora}`, gravado: `${voucher.data} ${voucher.hora}` });
        const d = await desfazer(ctx, [...feitos, { it, voucher }]);
        return await falhar(nega("divergente", { pessoa: it.pessoa.primeiroNome, desfeitas: d.desfeitas, mensagem: d.presas.length ? "A marcação saiu diferente do pedido e não conseguimos desfazer sozinhos. Fale com a recepção: eles resolvem rápido." : "A marcação saiu diferente do pedido e foi desfeita. Vamos tentar de novo, sem pressa." }, 502));
      }
      feitos.push({ it, voucher }); continue;
    }
    const d = await desfazer(ctx, feitos);
    for (const x of prontos) if (!feitos.some((f) => f.it === x)) await soltarReserva(ctx, x);
    if (d.presas.length) return await falhar(nega("parcial", { pessoas_marcadas: d.presas, mensagem: "Marcamos só uma parte e não conseguimos desfazer. Fale com a recepção, por favor: eles resolvem rápido." }, 502));
    return await falhar({ status: r.status, corpo: { ok: false, motivo: String(r.corpo.motivo ?? "erro"), ...(r.corpo.mensagem ? { mensagem: r.corpo.mensagem } : {}), pessoa: it.pessoa.primeiroNome, desfeitas: d.desfeitas } });
  }
  await db.segurarMarcar(grupo, SEGURAR_S, Object.fromEntries(feitos.map((f) => [f.it.slot.id, String(f.voucher.id)])));          // marcado: continua separado alguns minutos, até a lista do Klingo "alcançar"
  for (const { it, voucher } of feitos) {
    await db.marcacaoGravar({ voucher_id: voucher.id, pessoa_id: it.pessoa.id, grupo_id: prontos.length > 1 ? grupo : null, procedimento: voucher.procedimento, procedimento_id: voucher.procedimento_id ?? String(it.marca.procedimento), profissional: voucher.profissional ?? it.hint.medico, unidade: voucher.unidade ?? it.hint.unidade, data: voucher.data, hora: voucher.hora, status: "agendado" });
    if (it.remarcar) { await db.marcacaoGravar({ voucher_id: it.remarcar, pessoa_id: it.pessoa.id, status: "remarcado" }); await db.liberarVoucher(it.remarcar); await db.filaPedir("espera:agora", { tipo: "espera", forcar: true }, 1); }   // o horário antigo ficou livre: a fila de espera olha na hora
    await db.filaPedir(`vouchers:${it.pessoa.id}`, { tipo: "vouchers", pessoa: it.pessoa.id }, 2);
  }
  return ok({ grupo, marcacoes: feitos.map(({ it, voucher }) => ({ pessoa: it.pessoa.id, nome: it.pessoa.primeiroNome, voucher })) });
}

async function marcarJuntos(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  if (c.confirmar !== true) return nega("sem_confirmacao", { mensagem: "Ação não confirmada." }, 400);
  const itens = Array.isArray(c.itens) ? c.itens as Array<Record<string, unknown>> : [];
  if (!itens.length || itens.length > MAX_PESSOAS_POR_VEZ) return invalido("itens");
  if (new Set(itens.map((i) => String(i.pessoa))).size !== itens.length) return invalido("pessoas");
  const nec = lerNecessidade(c.necessidade);
  if (ehResposta(nec)) return nec;
  return await executarMarcacao(ctx, ap, itens, nec);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Fila de espera por pressa: "se alguém desmarcar, me chame"
// ---------------------------------------------------------------------------------------------------------------------------------------------
// Quem tem pressa (hoje, esta semana) ou só quer adiantar (já tem horário, mas toparia mais cedo) entra na fila da necessidade (a especialidade ou o exame + o plano).
// Toda vez que um horário abre (alguém desmarcou, remarcou, ou a agenda mudou), a rotina oferece o MAIS CEDO possível para o primeiro da fila, segura o horário para ele por alguns minutos (15)
// e só passa ao próximo se ele recusar ou o prazo acabar. Ordem justa: hoje > esta semana > qualquer dia; quem ainda não tem horário vem antes de quem só quer adiantar; depois quem espera há mais tempo.
const URGENCIAS = ["hoje", "semana", "qualquer"];
async function esperaEntrar(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  const p = await pessoaPlena(ctx, ap.id, String(c.pessoa ?? ""));
  if (!p) return nega("pessoa_nao_encontrada", { mensagem: "Esta pessoa não está ligada a este celular." }, 403);
  const nec = lerNecessidade(c.necessidade);
  if (ehResposta(nec)) return nec;
  const urgencia = String(c.urgencia ?? "");
  if (!URGENCIAS.includes(urgencia)) return invalido("urgencia");
  let voucher: string | null = null, data: string | null = null, hora: string | null = null;
  if (c.voucher !== undefined && c.voucher !== null && c.voucher !== "") {            // quer ADIANTAR um horário que já tem
    voucher = digitos(c.voucher, 1, 12);
    const m = voucher ? (await ctx.fam.db!.acompanhar(ap.id)).find((x) => x.voucher === voucher && x.pessoa === p.id && ABERTAS.has(x.status)) : null;
    if (!m) return nega("voucher_nao_encontrado", { mensagem: "Não achamos esta marcação entre as de " + p.primeiroNome + "." });
    data = m.data; hora = m.hora;
  }
  const plano = p.planoId ?? 1, r = await ctx.fam.db!.esperaEntrar(ap.id, p.id, chaveNecessidade(nec, plano), { ...(nec.especialidade ? { especialidade: nec.especialidade } : { exame: nec.exame }), plano: String(plano), nome: nec.nome }, urgencia, voucher, data, hora);
  if (!r.ok) return nega(r.motivo ?? "erro", { limite: r.limite, mensagem: r.motivo === "limite_espera" ? `${p.primeiroNome} já está em ${r.limite ?? 3} filas de espera. Saia de uma para entrar em outra.` : undefined });
  await ctx.fam.db!.filaPedir("espera:agora", { tipo: "espera", forcar: true }, 3);     // se já existe horário mais cedo livre, a rotina oferece no próximo minuto
  return ok({ id: r.id, ja_estava: r.ja_estava === true });
}
async function esperaSair(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  const id = Number(c.id);
  if (!Number.isInteger(id) || id < 1) return invalido("id");
  const r = await ctx.fam.db!.esperaSair(ap.id, id);
  return r.ok ? ok({ saiu: true }) : nega("nao_encontrada", { mensagem: "Esta espera não está mais ativa." });
}
async function esperaResponder(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  const id = Number(c.id);
  if (!Number.isInteger(id) || id < 1 || typeof c.aceita !== "boolean") return invalido("id");
  const r = await ctx.fam.db!.esperaResponder(ap.id, id, c.aceita);
  if (!r.ok) return nega(r.motivo ?? "oferta_invalida", { mensagem: r.motivo === "oferta_vencida" ? "O tempo desta oferta acabou. Você continua na fila e avisamos se abrir outro horário." : "Esta oferta não vale mais." });
  if (!c.aceita || !r.espera) return ok({ recusou: true });
  const e = r.espera, o = e.oferta as { chave?: string; procedimento?: string; medico?: string; unidade?: string }, params = e.params as { especialidade?: string; exame?: string; nome?: string; plano?: string };
  const nec: Necessidade = { ...(params.especialidade ? { especialidade: String(params.especialidade) } : { exame: String(params.exame) }), nome: String(params.nome ?? "Atendimento") };
  const resp = await executarMarcacao(ctx, ap, [{ pessoa: e.pessoa, horario: o.chave, procedimento: o.procedimento, plano: params.plano, medico: o.medico, unidade: o.unidade, ...(e.voucher_atual ? { remarcar: e.voucher_atual } : {}) }], nec, { grupoFixo: e.grupo });
  if (resp.corpo.ok === true) { const v = (resp.corpo.marcacoes as Array<{ voucher: { id: string } }>)[0]?.voucher?.id; await ctx.fam.db!.esperaConcluir(e.id, String(v ?? "")); return { status: resp.status, corpo: { ...resp.corpo, espera_concluida: true } }; }
  if (resp.corpo.motivo === "ja_tem_marcacao") await ctx.fam.db!.esperaSair(ap.id, e.id).catch(() => {});     // já marcou por outro caminho: a espera não faz mais sentido
  else await ctx.fam.db!.esperaFalhou(e.id);                                                                  // não deu certo: volta para a fila (sem repetir este horário) e solta o horário
  return resp;
}

async function horariosFrescos(ctx: CtxFam, q: Record<string, string>, forcar: boolean): Promise<Horario[]> {
  const chave = chaveHorarios(q), c = await ctx.fam.db!.cacheLer(chave);
  if (!forcar && c && Array.isArray(c.dados) && !c.vencido) return c.dados as Horario[];
  try { const lista = await ctx.api.horarios(q); await ctx.fam.db!.cacheGravar(chave, lista, CACHE_FRESCO_S); return lista; }
  catch (e) { if (e instanceof KlingoErro && (e.tipo === "sem_medico" || e.tipo === "plano_inativo" || e.tipo === "plano_desconhecido")) return []; throw e; }
}
/** O horário mais cedo que serve para esta pessoa: dentro do limite que ela pediu, não recusado antes e, para quem só quer adiantar, pelo menos 2 horas antes do que ela já tem. */
export function escolherSlot(c: Candidata, slots: Horario[], usados: Set<string>): Horario | null {
  const recusadas = new Set(c.recusadas), atual = c.data_atual && c.hora_atual ? comecaEm({ data: c.data_atual, hora: c.hora_atual }) : null;
  for (const h of slots) {
    if (usados.has(h.id) || recusadas.has(h.id)) continue;
    if (c.limite && h.data > c.limite) continue;
    if (atual !== null && comecaEm(h) > atual - 2 * 3_600_000) continue;
    return h;
  }
  return null;
}
/** Olha as filas, na ordem justa, e oferece os horários que abriram. Poucas leituras por vez (cache de 90 s por necessidade). */
export async function processarEspera(ctx: CtxFam, o: { max?: number; forcar?: boolean } = {}): Promise<{ ofertas: number; necessidades: number }> {
  const db = ctx.fam.db!;
  await db.esperaExpirar();
  const needs = await db.esperaNecessidades(Math.max(1, o.max ?? TETO_FILA_POR_MINUTO)), cfg = await db.config(), hoje = ctx.hoje();
  let ofertas = 0;
  for (const n of needs) {
    const p = n.params as { especialidade?: string; exame?: string; plano?: string; nome?: string };
    const nec: Necessidade = { ...(p.especialidade ? { especialidade: String(p.especialidade) } : { exame: String(p.exame) }), nome: String(p.nome ?? "Atendimento") };
    const lista = await horariosFrescos(ctx, consultaDe(nec, p.plano ?? "1", hoje, somarDias(hoje, 30)), o.forcar === true);
    const livres = await tirarIndisponiveis(ctx, lista, null), usados = new Set<string>();
    for (const cand of await db.esperaCandidatas(n.need_key)) {
      const h = escolherSlot(cand, livres, usados);
      if (!h) continue;
      const r = await db.esperaOfertar(cand.id, { ...slotLivro(h), data: h.data, hora: h.hora, medico: h.profissional?.nome ?? null, procedimento: String(h.procedimento ?? ""), ordem_chegada: h.ordem_chegada }, Math.max(5, cfg.oferta_min) * 60);
      if (r.ok) { usados.add(h.id); ofertas++; }
    }
    await db.esperaLida(n.need_key);
  }
  return { ofertas, necessidades: needs.length };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Acompanhar (rastreio) e a rotina lenta
// ---------------------------------------------------------------------------------------------------------------------------------------------
const ABERTAS = new Set(["agendado", "confirmado", "chegou", "atendido"]);
async function acompanhar(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  const marcacoes = await ctx.fam.db!.acompanhar(ap.id);
  const previsoes: Record<string, unknown> = {};
  for (const proc of new Set(marcacoes.filter((m) => ABERTAS.has(m.status) && m.procedimento).map((m) => m.procedimento!))) previsoes[proc] = await ctx.fam.db!.previsaoLaudo(proc).catch(() => ({ amostra: 0 }));
  for (const pessoa of new Set(marcacoes.filter((m) => ABERTAS.has(m.status)).map((m) => m.pessoa))) await ctx.fam.db!.filaPedir(`vouchers:${pessoa}`, { tipo: "vouchers", pessoa }, 2);
  return ok({ marcacoes, previsoes, espera: await ctx.fam.db!.esperaListar(ap.id), proxima_leitura_s: 60, agora: new Date(ctx.agora()).toISOString() });
}

const STATUS_DO_KLINGO: Record<string, string> = { agendado: "agendado", checkin: "chegou", atendido: "atendido" };
/** Lê as marcações da pessoa no Klingo e atualiza o rastreio. Marcação que sumiu da lista de ativas e ainda é futura foi cancelada. */
export async function atualizarPessoa(ctx: CtxFam, pessoaId: string): Promise<{ lidas: number }> {
  const db = ctx.fam.db!, abertas = await db.marcacoesAbertas(pessoaId);
  if (!abertas.length) return { lidas: 0 };
  const l = await db.pessoaLerServico(pessoaId);
  if (!l) return { lidas: 0 };
  const d = await decifrar<{ cpf: string; nascimento: string }>(l.dados_cifrados, ctx.fam.chave!);
  const s = await sessaoDaPessoa(ctx, { cpf: d.cpf, nascimento: d.nascimento, klingoId: l.klingo_id });
  if (ehResp(s)) throw new KlingoErro(0, "sessao", "outro");
  const ativos = new Map((await vouchersAtivos(ctx, s)).map(resumoVoucher).map((v) => [String(v.id), v]));
  const hoje = ctx.hoje();
  for (const m of abertas) {
    const v = ativos.get(m.voucher);
    let status = m.status;
    if (v) { const novo = STATUS_DO_KLINGO[String(v.status ?? "").toLowerCase()]; if (novo && !(novo === "agendado" && m.status === "confirmado")) status = novo; }
    else if (m.data && m.data >= hoje) status = "cancelado";
    if (status === "atendido" && ctx.resultado) {
      try { const r = await ctx.api.chamar<Record<string, unknown>>("GET", `/resultado/${m.voucher}`); if (r && typeof r === "object" && (r.pronto === true || r.pronto === 1 || r.pronto === "S")) status = "laudo_pronto"; } catch { /* sem laudo ainda (403 em página HTML): segue como atendido */ }
    }
    if (status !== m.status) await db.marcacaoGravar({ voucher_id: m.voucher, pessoa_id: pessoaId, status });
  }
  return { lidas: ativos.size };
}

/** A rotina lenta (pg_cron chama a cada minuto): pega no máximo 3 tarefas; se o Klingo reclamar (429), larga o resto para depois (vai com menos). */
export async function rodarFila(ctx: CtxFam, max = TETO_FILA_POR_MINUTO): Promise<{ feitas: number; adiadas: number; falhas: number; freio: boolean; ofertas: number }> {
  const db = ctx.fam.db!, tarefas = await db.filaPegar(Math.min(max, TETO_FILA_POR_MINUTO));
  let feitas = 0, adiadas = 0, falhas = 0, freio = false, ofertas = 0;
  if (!tarefas.length) { await precarregar(ctx).catch(() => {}); const e = await processarEspera(ctx).catch(() => ({ ofertas: 0 })); return { feitas, adiadas, falhas, freio, ofertas: e.ofertas }; }
  const ativas = tarefas.some((t) => t.params.tipo === "vouchers") ? new Set(await db.pessoasAtivas(60)) : new Set<string>();
  for (const t of tarefas) {
    if (freio) { await db.filaFim(t.id, true, null, 60); adiadas++; continue; }
    try {
      const tipo = String(t.params.tipo ?? "");
      if (tipo === "horarios") {
        const q = t.params.q as Record<string, string>;
        await db.cacheGravar(t.chave, await ctx.api.horarios(q), CACHE_FRESCO_S);
        await db.filaFim(t.id, true, null, null);
      } else if (tipo === "vouchers") {
        const pessoa = String(t.params.pessoa ?? "");
        await atualizarPessoa(ctx, pessoa);
        const seguir = ativas.has(pessoa) && (await db.marcacoesAbertas(pessoa)).length > 0;
        await db.filaFim(t.id, true, null, seguir ? 60 : null);      // continua a cada minuto só enquanto alguém usa o celular e há o que acompanhar
      } else if (tipo === "espera") {
        ofertas += (await processarEspera(ctx, { max: 3, forcar: t.params.forcar === true })).ofertas;
        await db.filaFim(t.id, true, null, null);
      } else await db.filaFim(t.id, true, null, null);
      feitas++;
    } catch (e) {
      falhas++;
      if (e instanceof KlingoErro && e.tipo === "limite") freio = true;
      await db.filaFim(t.id, false, e instanceof KlingoErro ? e.tipo : "erro");
    }
  }
  if (!freio && tarefas.length < TETO_FILA_POR_MINUTO) ofertas += (await processarEspera(ctx, { max: TETO_FILA_POR_MINUTO - tarefas.length }).catch(() => ({ ofertas: 0 }))).ofertas;   // sobrou fôlego no minuto: olha a fila de espera
  return { feitas, adiadas, falhas, freio, ofertas };
}

/** Quando a fila está vazia, deixa a agenda pronta para quem chegar: as especialidades × os planos que as famílias usam (mais o particular), uma janela de 10 dias, sem pressa (prioridade 9).
 *  Cada combinação só é pedida de novo quando o cache dela tem mais de 5 minutos; assim são poucas leituras por minuto, e a pessoa encontra tudo pronto. */
export async function precarregar(ctx: CtxFam): Promise<number> {
  const db = ctx.fam.db!, r = await ctx.api.chamar<unknown>("GET", "/agenda/especialidades");
  const lista = Array.isArray(r) ? r : Array.isArray((r as { dados?: unknown })?.dados) ? (r as { dados: unknown[] }).dados : [];
  const cbos = lista.map((e) => String((e as Record<string, unknown>)?.cbos ?? "")).filter((c) => /^\d{4,8}$/.test(c)).slice(0, 8);
  const planos = [...new Set([1, ...(await db.planosEmUso())])].slice(0, 6), inicio = ctx.hoje();
  let pedidos = 0;
  for (const plano of planos) for (const c of cbos) {
    if (pedidos >= 3) return pedidos;
    const q = { especialidade: c, fim: somarDias(inicio, 9), inicio, plano: String(plano) }, chave = chaveHorarios(q), vivo = await db.cacheLer(chave);
    if (vivo && ctx.agora() - Date.parse(vivo.buscado_em) < 5 * 60_000) continue;
    await db.filaPedir(chave, { tipo: "horarios", q }, 9); pedidos++;
  }
  return pedidos;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Cancelar, "Cheguei" (check-in) e a regra das 24 horas
// ---------------------------------------------------------------------------------------------------------------------------------------------
const PRAZO_CANCELAR_H = 24;
/** A marcação é de uma pessoa deste celular? Devolve a marcação e a pessoa com a sessão aberta no Klingo. */
async function minhaMarcacao(ctx: CtxFam, c: Record<string, unknown>): Promise<{ ap: Aparelho; m: MarcacaoVista; p: Pessoa; s: Sessao } | Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  if (c.confirmar !== true) return nega("sem_confirmacao", { mensagem: "Ação não confirmada." }, 400);
  const voucher = digitos(c.voucher, 1, 12);
  if (!voucher) return invalido("voucher");
  const m = (await ctx.fam.db!.acompanhar(ap.id)).find((x) => x.voucher === voucher);
  if (!m) return nega("voucher_nao_encontrado", { mensagem: "Não achamos esta marcação entre as dos seus pacientes." }, 403);
  const p = await pessoaPlena(ctx, ap.id, m.pessoa);
  if (!p) return nega("pessoa_nao_encontrada", { mensagem: "Esta pessoa não está ligada a este celular." }, 403);
  const s = await sessaoDaPessoa(ctx, p);
  if (ehResp(s)) return s;
  if (!(await vouchersAtivos(ctx, s)).some((v) => String(v.id) === voucher)) return nega("voucher_nao_encontrado", { mensagem: "Esta marcação já não está ativa." });
  return { ap, m, p, s };
}

async function cancelar(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const x = await minhaMarcacao(ctx, c);
  if (ehResposta(x)) return x;
  // mesma regra do chat (24 h): perto da hora quem resolve é uma pessoa da recepção, com carinho
  if (x.m.data && x.m.hora) {
    const falta = (Date.parse(`${x.m.data}T${x.m.hora.slice(0, 5)}:00-03:00`) - ctx.agora()) / 3_600_000;
    if (falta < PRAZO_CANCELAR_H) return nega("perto_demais", { mensagem: "Falta pouco tempo para o atendimento. Fale com a recepção que a gente resolve junto com você." });
  }
  try { await ctx.api.chamar("DELETE", "/voucher", { sessao: x.s.token, corpo: { id: x.m.voucher } }); } catch (e) {
    if (e instanceof KlingoErro && e.tipo === "ja_cancelado") { /* já estava: segue e marca */ }
    else if (e instanceof KlingoErro && e.incerto) {
      if ((await vouchersAtivos(ctx, x.s)).some((v) => String(v.id) === x.m.voucher)) return nega("incerto", { mensagem: "Não conseguimos confirmar o cancelamento. Veja o acompanhamento daqui a pouco." }, 502);
    } else throw e;
  }
  await ctx.fam.db!.marcacaoGravar({ voucher_id: x.m.voucher, pessoa_id: x.p.id, status: "cancelado" });
  await ctx.fam.db!.liberarVoucher(x.m.voucher);
  await ctx.fam.db!.filaPedir("espera:agora", { tipo: "espera", forcar: true }, 1);     // o horário ficou livre: quem está na fila de espera é chamado agora
  return ok({ cancelado: x.m.voucher });
}

async function checkin(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const x = await minhaMarcacao(ctx, c);
  if (ehResposta(x)) return x;
  try {
    const r = await ctx.api.chamar<Record<string, unknown>>("POST", "/checkin", { sessao: x.s.token, corpo: { id: Number(x.m.voucher), expresso: false, preferencial: c.preferencial === true } });
    const ck = ((r as { checkinrealizado?: Record<string, unknown> })?.checkinrealizado ?? r) as Record<string, unknown>;
    await ctx.fam.db!.marcacaoGravar({ voucher_id: x.m.voucher, pessoa_id: x.p.id, status: "chegou" });
    return ok({ chegou: x.m.voucher, recepcao: ck?.recepcao ?? null, local: ck?.local ?? null });
  } catch (e) { return traduzir(e); }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Outros responsáveis: convite, "todos os dados", aviso, desligar, laudo
// ---------------------------------------------------------------------------------------------------------------------------------------------
const codigoNumerico = () => { const n = crypto.getRandomValues(new Uint32Array(2)); return String((n[0] * 4294967296 + n[1]) % 100_000_000).padStart(8, "0"); };

async function convidar(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  const pedidas = Array.isArray(c.pessoas) && c.pessoas.length ? c.pessoas.map(String) : ap.pessoas.filter((p) => p.nivel === 2).map((p) => p.id);
  if (!pedidas.length || pedidas.length > 10) return nega("sem_acesso_ao_laudo", { mensagem: "Só quem já abre os resultados pode dar acesso a outra pessoa." });
  const codigo = codigoNumerico(), r = await ctx.fam.db!.conviteCriar(ap.id, pedidas, await sha256("convite:" + codigo));
  if (!r.ok) return nega(r.motivo ?? "erro", { mensagem: "Só quem já abre os resultados pode dar acesso a outra pessoa." });
  return ok({ codigo, expira_em: r.expira_em });
}

async function usarConvite(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const codigo = soDigitos(c.codigo);
  if (codigo.length !== 8) return invalido("codigo");
  const ap = await aparelhoOuNovo(ctx, c);
  if (ehResposta(ap)) return ap;
  const r = await ctx.fam.db!.conviteUsar(await sha256("convite:" + codigo), ap.id);
  if (!r.ok) { if (ap.tokenNovo) await ctx.fam.db!.aparelhoDesligar(ap.id); return nega(r.motivo ?? "convite_invalido", { mensagem: r.motivo === "limite_aparelhos" ? "Esta pessoa já está em 3 celulares." : "Este código não vale mais. Peça um novo." }); }
  return ok({ ...(ap.tokenNovo ? { token: ap.tokenNovo } : {}), ligadas: r.ligadas, pessoas: await pessoasDoAparelho(ctx, c, ap.tokenNovo, ap.id) });
}

/** "Eu sei todos os dados": CPF, nascimento, nome completo e celular do cadastro, conferidos no Klingo. 3 erros em 1 hora travam só esta porta (os celulares já ligados não são afetados). */
async function porDados(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const cpf = cpfValido(c.cpf), nascimento = dataIso(c.nascimento), nome = curto(c.nome, 100, 3), celular = digitos(soDigitos(c.celular), 10, 11);
  if (!cpf) return invalido("cpf"); if (!nascimento) return invalido("nascimento"); if (!nome) return invalido("nome"); if (!celular) return invalido("celular");
  const chaveTrava = "dados:" + cpf + nascimento;
  if ((await ctx.db.divergentesRecentes(await ctx.db.hash(chaveTrava))) >= 3) return nega("tentativas_demais", { mensagem: "Muitas tentativas por aqui. Peça a quem já acompanha para dar acesso, ou procure a recepção." }, 429);
  const recusar = async (): Promise<Resp> => { await ctx.db.registrarTentativa(chaveTrava); return nega("nao_confere", { mensagem: "Algum dado não confere. Veja se está igual ao cadastro na clínica." }); };

  // quem é a pessoa: a que já existe aqui com este CPF + nascimento e este nome (gêmeos têm o mesmo par), ou o próprio paciente no Klingo
  type Dados = { nome: string; celular?: string };
  let alvo: { klingoId: string | null; pessoaId: string | null; dados: Dados | null } = { klingoId: null, pessoaId: null, dados: null };
  for (const e of await ctx.fam.db!.pessoasPorPar(await ctx.db.hash(`${cpf}|${nascimento}`))) {
    const d = await decifrar<Dados>(e.dados_cifrados, ctx.fam.chave!);
    if (norm(d.nome) === norm(nome)) { alvo = { klingoId: e.klingo_id, pessoaId: e.id, dados: d }; break; }
  }
  const s = await sessaoDaPessoa(ctx, { cpf, nascimento, klingoId: alvo.klingoId });
  if (ehResp(s)) return s.corpo.motivo === "nao_confere" ? await recusar() : s;
  // o que vale como "dado do cadastro": o que a família já guardou aqui (cadastro feito por esta página) ou, senão, o que o Klingo devolve do paciente
  let nomeRef: string | null = alvo.dados?.nome ?? null, celRef: string | null = alvo.dados?.celular ?? null;
  if (!celRef) {
    try {
      const cad = (await ctx.api.chamar<Record<string, unknown>>("GET", "/paciente", { sessao: s.token })) ?? {}, ct = (cad.contatos ?? {}) as Record<string, unknown>;
      nomeRef = String(cad.nome ?? s.user.nome ?? ""); celRef = soDigitos(ct.celular ?? ct.telefone ?? "");
    } catch (e) { if (!(e instanceof KlingoErro)) throw e; return await recusar(); }
  }
  const nomeK = nomeRef;
  if (norm(nomeRef ?? "") !== norm(nome) || !celRef || soDigitos(celRef).slice(-9) !== celular.slice(-9)) return await recusar();
  const pl = planoDe(s.user);
  const pessoaId = alvo.pessoaId ?? (await guardarPessoa(ctx, { cpf, nascimento, nome: String(nomeK).trim(), celular, cpfDe: "proprio", klingoId: s.id, planoId: pl.id, planoNome: pl.nome })).id;
  const ap = await aparelhoOuNovo(ctx, c);
  if (ehResposta(ap)) return ap;
  const r = await ctx.fam.db!.pedirPorDados(ap.id, pessoaId, c.papel === "proprio" ? "proprio" : "responsavel");
  if (!r.ok) { if (ap.tokenNovo) await ctx.fam.db!.aparelhoDesligar(ap.id); return nega(r.motivo ?? "erro", { limite: (r as { limite?: number }).limite }); }
  return ok({ ...(ap.tokenNovo ? { token: ap.tokenNovo } : {}), imediato: r.imediato === true, espera_ate: r.espera_ate ?? null, pessoas: await pessoasDoAparelho(ctx, c, ap.tokenNovo, ap.id) });
}

async function responderAviso(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  const id = Number(c.aviso);
  if (!Number.isInteger(id) || id < 1 || typeof c.liberar !== "boolean") return invalido("aviso");
  const r = await ctx.fam.db!.avisoResponder(ap.id, id, c.liberar);
  return r.ok ? ok({ liberado: c.liberar }) : nega(r.motivo ?? "aviso_invalido", { mensagem: "Este aviso não vale mais." });
}

async function desligar(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  await ctx.fam.db!.aparelhoDesligar(ap.id);
  return ok({ desligado: true });
}

async function laudo(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  if (!ctx.resultado) return nega("desligado", { mensagem: "A entrega do resultado por aqui ainda não foi liberada pela clínica. Peça na recepção." });
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  const voucher = digitos(c.voucher, 1, 12);
  if (!voucher) return invalido("voucher");
  const m = (await ctx.fam.db!.acompanhar(ap.id)).find((x) => x.voucher === voucher);
  if (!m) return nega("voucher_nao_encontrado", { mensagem: "Não achamos esta marcação entre as dos seus pacientes." }, 403);
  const p = ap.pessoas.find((x) => x.id === m.pessoa);
  if (!p || p.nivel !== 2) return nega("laudo_exige_confianca", { espera_ate: p?.espera_ate ?? null, mensagem: p?.espera_ate ? "O acesso ao resultado será liberado em breve." : "Para abrir o resultado, este celular precisa ser liberado: leia o código na recepção, peça um convite a quem já acompanha, ou entre com todos os dados." }, 403);
  const freio = await ctx.fam.db!.acessoRegistrar(ap.id, p.id, voucher);
  if (!freio.ok) return nega("devagar", { mensagem: "Muitas aberturas seguidas. Espere um minuto." }, 429);
  try {
    const r = await ctx.api.chamar<unknown>("GET", `/resultado/${voucher}`);
    const o = (typeof r === "object" && r ? r : { conteudo: r }) as Record<string, unknown>;
    const pronto = o.pronto === true || o.pronto === 1 || o.pronto === "S";
    if (pronto && m.status !== "laudo_pronto") await ctx.fam.db!.marcacaoGravar({ voucher_id: voucher, pessoa_id: p.id, status: "laudo_pronto" });
    return ok({ pronto, formato: "html", ...(pronto ? { resultado: o } : {}) });     // o conteúdo do laudo não é guardado nem vai para log
  } catch (e) {
    if (e instanceof KlingoErro && (e.tipo === "html" || e.status === 403)) return ok({ pronto: false, motivo: "sem_resultado" });
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Ponto de entrada
// ---------------------------------------------------------------------------------------------------------------------------------------------
const ACOES: Record<string, (ctx: CtxFam, c: Record<string, unknown>) => Promise<Resp>> = {
  fam_entrar: entrar, fam_eu: eu, fam_dependente: dependente, fam_buscar: buscar, fam_marcar: marcarJuntos, fam_acompanhar: acompanhar, fam_convidar: convidar, fam_convite_usar: usarConvite,
  fam_dados: porDados, fam_aviso: responderAviso, fam_desligar: desligar, fam_laudo: laudo, fam_cancelar: cancelar, fam_checkin: checkin, fam_espera_entrar: esperaEntrar, fam_espera_sair: esperaSair, fam_espera_responder: esperaResponder,
};

export async function tratarFamilia(ctx: Ctx & { fam?: CtxFam["fam"] }, c: Record<string, unknown>): Promise<Resp> {
  const acao = String(c?.acao ?? "");
  if (!ctx.fam?.db || !ctx.fam.chave) return semChave();
  const f = ctx as CtxFam;
  if (acao === "fam_sincronizar") {
    const esperado = f.fam.chaveSync ?? "", enviado = String(c.segredo ?? "");
    if (esperado.length < 20 || !igual(esperado, enviado)) return nega("nao_autorizado", {}, 403);
    try { return ok(await rodarFila(f, Number(c.max) || TETO_FILA_POR_MINUTO)); } catch (e) { return traduzir(e); }
  }
  const fn = ACOES[acao];
  if (!fn) return nega("acao_invalida", { acoes: [...Object.keys(ACOES), "fam_sincronizar"] }, 400);
  try { return await fn(f, c); } catch (e) { return traduzir(e); }
}

/** Entrada única da função: ações "fam_*" vão para a família; o resto segue como sempre (regras.ts). */
export async function tratarTudo(ctx: Ctx & { fam?: CtxFam["fam"] }, c: Record<string, unknown>): Promise<Resp> {
  return String(c?.acao ?? "").startsWith("fam_") ? await tratarFamilia(ctx, c) : await tratar(ctx, c);
}
export type { Slot };
