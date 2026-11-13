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
//   fam_desligar      desliga ESTE celular.
//   fam_laudo         abre o laudo (só celular de nível 2 e só se AGENDAMENTO_RESULTADO=1: o laudo pronto de verdade ainda NÃO foi testado com o Klingo).
//   fam_sincronizar   (rotina do pg_cron, com FAMILIA_SYNC_CHAVE) lê a fila lenta: no máximo 3 leituras por minuto, só 1 se o Klingo reclamou.
//
// Regras que o código cumpre: CPF, nascimento, nome e celular só existem CIFRADOS no banco (cripto.ts); nada disso volta para a página; toda leitura do Klingo passa pela cota global;
// aparelho desligado ou parado há 12 meses não entra; nível 1 marca e acompanha, só nível 2 abre laudo; laudo nunca é guardado nem vai para log; cada abertura é registrada sem conteúdo.
import { cpfValido, dataIso, type Horario, KlingoErro, resumoVoucher } from "./api.ts";
import { cifrar, decifrar, novoToken, sha256 } from "./cripto.ts";
import { combinar, norm, ordenarMedicos, paraTela, primeiroLivre, type Contagem, type Slot } from "./ordenar.ts";
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
  acessoRegistrar(aparelho: string, pessoa: string, voucher: string): Promise<{ ok: boolean; motivo?: string }>;
  cacheLer(chave: string): Promise<{ dados: unknown; buscado_em: string; vencido: boolean } | null>;
  cacheGravar(chave: string, dados: unknown, validoSeg: number): Promise<void>;
  filaPedir(chave: string, params: Record<string, unknown>, prioridade: number): Promise<void>;
  filaPegar(max: number): Promise<Tarefa[]>;
  filaFim(id: number, ok: boolean, erro?: string | null, refazerSeg?: number | null): Promise<void>;
};
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
  return ok({ apelido: ap.apelido, pessoas: ap.pessoas, avisos: await ctx.fam.db!.avisos(ap.id) });
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

async function horariosDoCache(ctx: CtxFam, q: Record<string, string>): Promise<{ lista: Horario[]; atualizadoEm: string; desatualizado: boolean; motivo?: string }> {
  const chave = "h:" + Object.entries(q).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
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
  if (!r.lista.length && !r.motivo) { dias = 30; r = await horariosDoCache(ctx, { inicio, fim: somarDias(inicio, dias), plano, ...(especialidade ? { especialidade } : { exame: exame! }) }); }   // vazio? amplia sozinho
  const [historico, procura] = await Promise.all([ctx.fam.db!.historico(ps.map((p) => p.id)), popularidade(ctx)]);
  const medicos = ordenarMedicos(r.lista, historico, procura);
  return ok({
    total: r.lista.length, janela: { inicio, fim: somarDias(inicio, dias) }, atualizado_em: r.atualizadoEm, desatualizado: r.desatualizado, ...(r.motivo ? { motivo: r.motivo } : {}), ...(planosDiferentes ? { aviso: "planos_diferentes" } : {}),
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

type Item = { pessoa: Pessoa; sessao: Sessao; marca: Marca; reserva: string | null; idExterno: string; hint: { medico: string | null; unidade: string | null } };
const soltarReserva = async (ctx: CtxFam, it: Item) => { if (it.reserva) await ctx.api.chamar("DELETE", "/agenda/reservar", { sessao: it.sessao.token, corpo: { id: Number(it.reserva) } }).catch(() => {}); };

async function marcarJuntos(ctx: CtxFam, c: Record<string, unknown>): Promise<Resp> {
  const ap = await aparelhoDe(ctx, c);
  if (ehResposta(ap)) return ap;
  if (c.confirmar !== true) return nega("sem_confirmacao", { mensagem: "Ação não confirmada." }, 400);
  const itens = Array.isArray(c.itens) ? c.itens as Array<Record<string, unknown>> : [];
  if (!itens.length || itens.length > MAX_PESSOAS_POR_VEZ) return invalido("itens");
  if (new Set(itens.map((i) => String(i.pessoa))).size !== itens.length) return invalido("pessoas");
  const grupo = ctx.uuid(), prontos: Item[] = [];
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i], p = await pessoaPlena(ctx, ap.id, String(it.pessoa ?? ""));
    if (!p) return nega("pessoa_nao_encontrada", { mensagem: "Esta pessoa não está ligada a este celular." }, 403);
    if (!CHAVE_HORARIO.test(String(it.horario ?? ""))) return invalido("horario");
    const marca = lerMarca({ horario: it.horario, procedimento: it.procedimento, plano: it.plano ?? p.planoId ?? 1, obs: it.obs });
    if ("status" in marca) return marca as Resp;
    const s = await sessaoDaPessoa(ctx, p);
    if (ehResp(s)) { for (const x of prontos) await soltarReserva(ctx, x); return s; }
    prontos.push({ pessoa: p, sessao: s, marca, reserva: null, idExterno: `pagina-${grupo}-${i}`, hint: { medico: curto(it.medico, 80), unidade: curto(it.unidade, 80) } });
  }
  // 1) reservar todos (nenhum é marcado antes de todos estarem seguros)
  for (let i = 0; i < prontos.length; i++) {
    const it = prontos[i];
    try {
      const r = await ctx.api.chamar<Record<string, unknown>>("POST", "/agenda/reservar", { sessao: it.sessao.token, corpo: corpoMarcacao(it.marca, it.idExterno) });
      const rv = ((r as { reserva?: Record<string, unknown> })?.reserva ?? r) as Record<string, unknown>;
      it.reserva = rv?.id !== undefined && rv?.id !== null ? String(rv.id) : null;
    } catch (e) {
      for (const x of prontos) await soltarReserva(ctx, x);
      if (e instanceof KlingoErro && e.tipo === "horario_ocupado") return nega("horario_ocupado", { indice: i, pessoa: it.pessoa.primeiroNome, mensagem: "Um dos horários acabou de ser ocupado. Vamos mostrar outros." });
      return traduzir(e);
    }
  }
  // 2) marcar todos; se um falhar, desfaz os que já foram (tudo ou nada)
  const feitos: Array<{ it: Item; voucher: ReturnType<typeof resumoVoucher> }> = [];
  for (const it of prontos) {
    const r = await marcarComSessao(ctx, it.sessao, it.marca, it.reserva, null, it.idExterno);
    const voucher = (r.corpo as { voucher?: ReturnType<typeof resumoVoucher> }).voucher;
    if (r.corpo.ok === true && voucher?.id) { feitos.push({ it, voucher }); continue; }
    const desfeitas: string[] = [], presas: string[] = [];
    for (const f of feitos) {
      try { await ctx.api.chamar("DELETE", "/voucher", { sessao: f.it.sessao.token, corpo: { id: f.voucher.id } }); desfeitas.push(f.it.pessoa.primeiroNome); } catch { presas.push(f.it.pessoa.primeiroNome); }
    }
    for (const x of prontos) if (!feitos.some((f) => f.it === x)) await soltarReserva(ctx, x);
    if (presas.length) return nega("parcial", { pessoas_marcadas: presas, mensagem: "Marcamos só uma parte e não conseguimos desfazer. Fale com a recepção, por favor: eles resolvem rápido." }, 502);
    return nega(String(r.corpo.motivo ?? "erro"), { ...(r.corpo.mensagem ? { mensagem: r.corpo.mensagem } : {}), pessoa: it.pessoa.primeiroNome, desfeitas }, r.status);
  }
  for (const { it, voucher } of feitos) {
    await ctx.fam.db!.marcacaoGravar({ voucher_id: voucher.id, pessoa_id: it.pessoa.id, grupo_id: prontos.length > 1 ? grupo : null, procedimento: voucher.procedimento, profissional: voucher.profissional ?? it.hint.medico, unidade: voucher.unidade ?? it.hint.unidade, data: voucher.data, hora: voucher.hora, status: "agendado" });
    await ctx.fam.db!.filaPedir(`vouchers:${it.pessoa.id}`, { tipo: "vouchers", pessoa: it.pessoa.id }, 2);
  }
  return ok({ grupo, marcacoes: feitos.map(({ it, voucher }) => ({ pessoa: it.pessoa.id, nome: it.pessoa.primeiroNome, voucher })) });
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
  return ok({ marcacoes, previsoes, proxima_leitura_s: 60, agora: new Date(ctx.agora()).toISOString() });
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
export async function rodarFila(ctx: CtxFam, max = TETO_FILA_POR_MINUTO): Promise<{ feitas: number; adiadas: number; falhas: number; freio: boolean }> {
  const db = ctx.fam.db!, tarefas = await db.filaPegar(Math.min(max, TETO_FILA_POR_MINUTO));
  let feitas = 0, adiadas = 0, falhas = 0, freio = false;
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
      } else await db.filaFim(t.id, true, null, null);
      feitas++;
    } catch (e) {
      falhas++;
      if (e instanceof KlingoErro && e.tipo === "limite") freio = true;
      await db.filaFim(t.id, false, e instanceof KlingoErro ? e.tipo : "erro");
    }
  }
  return { feitas, adiadas, falhas, freio };
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
  fam_dados: porDados, fam_aviso: responderAviso, fam_desligar: desligar, fam_laudo: laudo,
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
