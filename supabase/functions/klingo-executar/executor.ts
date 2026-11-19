// O coração da marcação automática (sem Deno, para testar com um Klingo de mentira). Versão 1.0 — 12/11/2026.
// Versão 1.1 — 14/11/2026 / Mudança: (a) tipo "ler_vouchers" (ver minhas marcações: lista as marcações ATIVAS do próprio paciente, só leitura); (b) remarcação confere, depois da marcação nova, se o voucher
//   antigo ainda está ativo (campo "antigo": ativo | cancelado | desconhecido) para o banco avisar a equipe se ficaram dois agendamentos ou nenhum.
//   Fluxo: Entrada (operação aprovada pelo banco) → Validação (identidade + sessão conferida) → Processamento (lista / marca / cancela) → Persistência (klingo_operacao_concluir) → Saída (Resultado).
//
// Recebe SÓ o que o banco entregou ao executor (a operação, os dados já validados da conversa e a oferta que o Klingo fez a ela) e devolve o resultado.
// Ordem, sem pular nada (cada passo que falha para tudo e devolve um código interno; nunca o corpo da resposta do Klingo):
//   1) identidade: GET /paciente/cpf; o nascimento tem que bater; só id definitivo "P…"; paciente novo só com a liberação do pré-cadastro e a trava por CPF
//   2) plano: o do cadastro/padrão, o MESMO da oferta
//   3) login com o id EXATO do Klingo e conferência da sessão (id, nascimento e, no pré-cadastro, o nome)
//   4) o horário ainda existe? (GET /agenda/horarios do dia com a sessão); se não, "horário tomado"
//   5) reservar -> marcar (id_externo = id da operação); se o resultado for incerto, reconcilia por GET /vouchers; se não achar, INCERTO (a equipe confere ANTES de marcar de novo)
// Versões 1.2 a 1.4 — 14/11/2026: pré-cadastro guardado para cancelar/remarcar/ver marcações; nome só conferido se informado; consulta de horário refeita sem sessão no 403.
// Versão 1.5 — 19/11/2026 / Mudança: ANTES de criar pré-cadastro (CPF não achado), procura o cadastro por TELEFONE + NASCIMENTO (POST /paciente/identificar) e só o usa se o nome também
//   conferir. Corrige o caso da criança cadastrada no chat com o CPF do responsável: o Klingo não achava o CPF e o chat criava um pré-cadastro duplicado. Só vale para MARCAR (nunca para
//   ver, cancelar ou remarcar, que continuam só por CPF ou pré-cadastro guardado). O resultado diz de onde veio o cadastro (campo "cadastro") para a equipe ver na conversa.
// Versão 1.6 — 19/11/2026 / Mudança: nome digitado incompleto (sem o último sobrenome) também confere; se houver cadastro com o mesmo telefone e nascimento mas nome diferente, avisa "provável duplicado".
// Cancelar e remarcar (etapa 4): mesma identidade e mesma sessão conferida; só mexem em voucher que está entre as marcações ATIVAS da sessão do próprio paciente.
import { cadastroParaComparar, camposDivergentes, type Horario, type KlingoApi, KlingoErro, nomeConfere, resumoPaciente, resumoVoucher, semAcento, dataIso } from "./klingo-api.ts";

export type Rpc = (nome: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error?: unknown }>;
export type Pegar = {
  operacao: { id: string; tipo: string; conversa_id: string; detalhe: Record<string, unknown> };
  dados: {
    tipo: string | null; plano: string | null; procedimento: number | null; cpf: string | null; nascimento: string | null; nome: string | null; mae?: string | null; sexo: string | null; celular: string | null; email: string | null;
    identidade: { situacao: string; tipo: string | null; klingo_id: string | null; plano_id: number | null } | null;
  };
  oferta: { chave: string; procedimento: number; plano: number; data: string; hora: string; profissional: string | null } | null;
};
export type Esp = { cbos: string; procedimentos: number[] };
export type Resultado = {
  estado: "sucesso" | "falha" | "incerto" | "horario_tomado";
  codigo?: string; http_status?: number; caminho?: string;
  voucher?: ReturnType<typeof resumoVoucher>;
  /** v1.1: só em "ler_vouchers" (marcações ativas do próprio paciente). */
  marcacoes?: Array<ReturnType<typeof resumoVoucher>>;
  /** v1.1: só em "ler_vouchers" com detalhe.resultado: exames já realizados e se o laudo está liberado (nunca o conteúdo). */
  resultados?: Array<{ id: string | null; procedimento: string | null; data: string | null; pronto: boolean | null }>;
  /** v1.1: só em "remarcar": situação do voucher ANTIGO depois da marcação nova. */
  antigo?: "ativo" | "cancelado" | "desconhecido";
  /** v1.5: só em marcar/remarcar. achado_telefone = cadastro existente achado por telefone + nascimento + nome; pre_novo = criou pré-cadastro novo; pre_novo_conferir (v1.6) = criou pré-cadastro novo MAS existe cadastro com o mesmo telefone e nascimento e nome diferente (provável duplicado). */
  cadastro?: "achado_telefone" | "pre_novo" | "pre_novo_conferir";
};

const falha = (codigo: string, e?: unknown): Resultado => ({ estado: "falha", codigo, ...(e instanceof KlingoErro ? { http_status: e.status, caminho: e.caminho } : {}) });
const dado = <T>(r: { data: unknown }) => r.data as T;

/** Pedido de horários equivalente ao da oferta (consulta = CBOS; exame = id do procedimento). */
export function pedidoDeHorarios(tipo: string | null, procedimento: number | null, esps: Esp[]): { especialidade?: string; exame?: string } | null {
  if (!procedimento) return null;
  if (tipo === "consulta") { const e = esps.find((x) => x.procedimentos.includes(procedimento)); return e ? { especialidade: e.cbos } : null; }
  if (tipo === "exame") return { exame: String(procedimento) };
  return null;
}

/** Acha, entre as marcações ativas, a que acabamos de criar (pelo id_externo; senão por data, hora e procedimento). */
export function acharVoucher(lista: Array<Record<string, unknown>>, opId: string, data: string, hora: string, procedimentoId: number): ReturnType<typeof resumoVoucher> | null {
  const rs = (Array.isArray(lista) ? lista : []).map((v) => ({ bruto: v, r: resumoVoucher(v) }));
  const porId = rs.find((x) => x.r.idExterno === opId);
  if (porId) return porId.r;
  const porHorario = rs.filter((x) => x.r.data === data && x.r.hora === hora && x.r.status !== "cancelado"
    && (String((x.bruto.procedimento as Record<string, unknown> | undefined)?.id ?? x.bruto.id_procedimento ?? "") === String(procedimentoId) || x.r.idExterno === null));
  return porHorario.length === 1 ? porHorario[0].r : null;
}

type Sessao = { token: string; idLogin: string; tipoId: "definitivo" | "pre"; planoCadastro: number | null; cadastro?: "achado_telefone" | "pre_novo" | "pre_novo_conferir" };

/**
 * v1.5: acha o cadastro DEFINITIVO por telefone + nascimento e só aceita se o nome do cadastro também conferir (três provas, não uma).
 * v1.6: devolve { id } quando acha e confere; { duplicado: true } quando existe cadastro definitivo com o MESMO telefone e nascimento mas nome que não confere
 * (a equipe é avisada de provável duplicado, e nada é usado); null quando não há nada.
 * Erro de rede/limite sobe (quem chama para a marcação em vez de arriscar um duplicado).
 */
export async function procurarCadastroPorTelefone(api: KlingoApi, d: Pegar["dados"]): Promise<{ id: string } | { duplicado: true } | null> {
  const tel = String(d.celular ?? "").replace(/\D/g, "");
  if (tel.length < 10 || !d.nome || !d.nascimento || semAcento(d.nome).split(" ").filter(Boolean).length < 2) return null;
  const r = await api.pacientePorTelefone(tel, d.nascimento);
  if (!r) return null;
  const id = String(r.user.id ?? "");
  if (!/^P\d+$/.test(id) || dataIso(r.user.nascimento) !== d.nascimento) return null;
  return nomeConfere(r.user.nome, d.nome) ? { id } : { duplicado: true };
}

/**
 * Passos comuns a toda operação em nome do paciente: identidade na API, plano (se exigido) e sessão conferida.
 * Devolve a sessão ou o Resultado que explica por que parou (nunca segue com identidade duvidosa).
 */
async function abrirSessao(api: KlingoApi, rpc: Rpc, p: Pegar, o: { planoDaOferta?: number; liberarNovo?: boolean } = {}): Promise<Sessao | Resultado> {
  const d = p.dados, op = p.operacao;
  let idLogin: string, tipoId: "definitivo" | "pre", planoCadastro: number | null = null;
  let pac: Record<string, unknown> | null = null;
  let cadastro: Sessao["cadastro"];
  try { pac = await api.pacientePorCpf(d.cpf!) as Record<string, unknown> | null; } catch (e) {
    if (!(e instanceof KlingoErro && e.tipo === "paciente_nao_identificado")) throw e;
  }
  // v1.2: pré-cadastro guardado para CPF + nascimento (só leitura; só vale com id numérico puro)
  const preGuardado = async (): Promise<string | null> => {
    const r = dado<{ klingo_id?: string | null } | null>(await rpc("klingo_pre_do_par", { p_cpf: d.cpf, p_nasc: d.nascimento }));
    const id = r?.klingo_id ?? null;
    return id && /^\d+$/.test(id) ? id : null;
  };
  const s = pac ? resumoPaciente(pac) : null;
  if (s?.id) {
    if (s.nascimento !== d.nascimento) {
      await rpc("klingo_identidade_registrar", { p_cpf: d.cpf, p_nasc: d.nascimento, p_r: { situacao: "divergente" }, p_conversa: null });
      return falha("nascimento_divergente");
    }
    if (!/^P\d+$/.test(s.id)) {
      // v1.2: id fora do formato definitivo = só tem pré-cadastro; usa o guardado para este CPF + nascimento
      const pre = await preGuardado();
      if (!pre) return falha("sem_id_definitivo");
      idLogin = pre; tipoId = "pre";
    } else {
    // nome, mãe, sexo, telefone e e-mail digitados x cadastro do Klingo (o Klingo manda): 1 divergente = a equipe valida; 2 ou mais = o paciente vai à clínica
    const dif = camposDivergentes(cadastroParaComparar(pac), d);
    if (dif.length >= 2) { await rpc("klingo_identidade_registrar", { p_cpf: d.cpf, p_nasc: d.nascimento, p_r: { situacao: "divergente" }, p_conversa: null }); return falha("divergencia_2:" + dif.join(",")); }
    if (dif.length === 1) return falha("divergencia_1:" + dif[0]);
    idLogin = s.id; tipoId = "definitivo"; planoCadastro = s.planoId;
    await rpc("klingo_identidade_registrar", { p_cpf: d.cpf, p_nasc: d.nascimento, p_r: { situacao: "confere", klingo_id: s.id, faltando: s.faltando, plano_id: s.planoId }, p_conversa: null });
    }
  } else {
    // sem cadastro definitivo: cancelar/remarcar/ver marcações usam o pré-cadastro guardado (v1.2); só marcar cria paciente novo
    const preExistente = o.liberarNovo === false ? await preGuardado() : null;
    if (o.liberarNovo === false && !preExistente) return falha("cadastro_nao_encontrado");
    if (preExistente) { idLogin = preExistente; tipoId = "pre"; }
    else {
    const liberado = dado<boolean>(await rpc("klingo_ativo", { p_conversa: op.conversa_id, p_chave: "klingo_api_pre_cadastro" }));
    if (!liberado) return falha("paciente_novo_nao_liberado");
    if (!d.nome || !d.sexo) return falha("dados_incompletos");
    // v1.5: antes de criar paciente novo, procura quem já é da clínica por telefone + nascimento (só se ainda não há pré-cadastro guardado para este CPF + nascimento)
    let achado: Awaited<ReturnType<typeof procurarCadastroPorTelefone>> = null;
    if (o.liberarNovo !== false && !(await preGuardado())) {
      try { achado = await procurarCadastroPorTelefone(api, d); } catch (e) { return falha("busca_cadastro_falhou", e); }
    }
    if (achado && "id" in achado) { idLogin = achado.id; tipoId = "definitivo"; cadastro = "achado_telefone"; }
    else {
    const r = dado<{ acao: string; klingo_id?: string }>(await rpc("klingo_pre_reservar", { p_op: op.id, p_cpf: d.cpf, p_nasc: d.nascimento }));
    if (r.acao === "existente" && r.klingo_id) { idLogin = r.klingo_id; tipoId = "pre"; }
    else if (r.acao === "criar") {
      let novo: { id: string };
      try {
        novo = await api.registrar({ nome: d.nome, sexo: d.sexo, nascimento: d.nascimento!, cpf: d.cpf!, celular: d.celular ?? undefined, email: d.email ?? undefined });
      } catch (e) {
        // resposta perdida: o pré-cadastro PODE ter sido criado. Não registra de novo (a trava por CPF fica) e chama a equipe.
        if (e instanceof KlingoErro && e.incerto) return { estado: "incerto", codigo: "registro_incerto", http_status: e.status, caminho: e.caminho };
        return falha("registro_falhou", e);
      }
      await rpc("klingo_pre_gravar", { p_op: op.id, p_cpf: d.cpf, p_nasc: d.nascimento, p_klingo_id: novo.id });
      idLogin = novo.id; tipoId = "pre"; cadastro = achado ? "pre_novo_conferir" : "pre_novo";
    } else return { estado: "incerto", codigo: "registro_em_andamento_ou_incerto" };
    }
    }
  }
  if (o.planoDaOferta !== undefined) {
    const pl = dado<{ plano_id?: number | null; motivo?: string }>(await rpc("klingo_plano_resolver", { p_operadora: d.plano, p_plano_cadastro: planoCadastro }));
    const plano = pl?.plano_id ?? null;
    if (!plano) return falha(pl?.motivo ?? "sem_traducao");
    if (plano !== o.planoDaOferta) return falha("plano_mudou_depois_da_oferta");
  }
  const { token, user } = await api.login(idLogin);
  // v1.3: o nome só é conferido quando foi informado na conversa
  const mesmoNome = tipoId === "definitivo" || !d.nome || semAcento(user.nome) === semAcento(d.nome);
  if (String(user.id ?? "") !== idLogin || dataIso(user.nascimento) !== d.nascimento || !mesmoNome) return falha("sessao_nao_confere");
  if (tipoId === "pre" && user.id_paciente) return falha("pre_cadastro_ja_definitivo");
  return { token, idLogin, tipoId, planoCadastro, ...(cadastro ? { cadastro } : {}) };
}

const ehResultado = (x: Sessao | Resultado): x is Resultado => "estado" in x;

/** Cancelar: só o voucher que está entre as marcações ATIVAS da sessão conferida do próprio paciente. Cancelar o que já foi cancelado é sucesso. */
export async function executarCancelamento(api: KlingoApi, rpc: Rpc, p: Pegar): Promise<Resultado> {
  const d = p.dados;
  const alvo = String(p.operacao.detalhe?.voucher ?? "");
  if (!d.cpf || !d.nascimento || !/^\d+$/.test(alvo)) return falha("dados_incompletos");
  let tentou = false;
  try {
    const s = await abrirSessao(api, rpc, p, { liberarNovo: false });
    if (ehResultado(s)) return s;
    const ativos = await api.vouchers(s.token);
    if (!(Array.isArray(ativos) ? ativos : []).some((v) => String(v.id) === alvo)) return { estado: "sucesso", codigo: "ja_cancelado", voucher: { id: alvo, status: "cancelado", data: null, hora: null, procedimento: null, unidade: null, profissional: null, idExterno: null } };
    tentou = true;
    try { await api.cancelarVoucher(s.token, alvo); } catch (e) {
      if (e instanceof KlingoErro && e.tipo === "ja_cancelado") return { estado: "sucesso", codigo: "ja_cancelado" };
      if (e instanceof KlingoErro && e.incerto) {
        try { const l2 = await api.vouchers(s.token); if (!(Array.isArray(l2) ? l2 : []).some((v) => String(v.id) === alvo)) return { estado: "sucesso", codigo: "reconciliado" }; } catch { /* continua incerto */ }
        return { estado: "incerto", codigo: e.tipo, http_status: e.status, caminho: e.caminho };
      }
      return falha(e instanceof KlingoErro ? e.tipo : "erro_interno", e);
    }
    return { estado: "sucesso", http_status: 200, caminho: "/voucher", voucher: { id: alvo, status: "cancelado", data: null, hora: null, procedimento: null, unidade: null, profissional: null, idExterno: null } };
  } catch (e) {
    if (tentou) return { estado: "incerto", codigo: e instanceof KlingoErro ? e.tipo : "erro_depois_de_cancelar" };
    return falha(e instanceof KlingoErro ? e.tipo : "erro_interno", e);
  }
}

/** Ver minhas marcações (v1.1): só leitura. Lista as marcações ATIVAS da sessão conferida do próprio paciente; nunca lista de outra pessoa. */
export async function executarConsulta(api: KlingoApi, rpc: Rpc, p: Pegar): Promise<Resultado> {
  const d = p.dados;
  if (!d.cpf || !d.nascimento) return falha("dados_incompletos");
  try {
    const s = await abrirSessao(api, rpc, p, { liberarNovo: false });
    if (ehResultado(s)) return s;
    const lista = await api.vouchers(s.token);
    const todos = (Array.isArray(lista) ? lista : []).map((v) => resumoVoucher(v)).filter((v) => v.id && /^\d+$/.test(v.id));
    if (p.operacao.detalhe?.resultado === true) {
      // resultado de exame: só diz se o laudo está liberado (o conteúdo nunca passa por aqui); erro numa consulta = "não consegui conferir" (pronto: null), nunca "pronto" por suposição
      const feitos = todos.filter((v) => /atendid|realizad/i.test(v.status ?? "")).slice(0, 5);
      const resultados: NonNullable<Resultado["resultados"]> = [];
      for (const v of feitos) {
        let pronto: boolean | null = null;
        try { pronto = (await api.resultadoPronto(v.id!)).pronto; } catch { pronto = null; }
        resultados.push({ id: v.id, procedimento: v.procedimento, data: v.data, pronto });
      }
      return { estado: "sucesso", codigo: resultados.length ? "ok_com_resultados" : "sem_exames_realizados", http_status: 200, caminho: "/resultado", resultados };
    }
    const marcacoes = todos.filter((v) => !/cancel|atendid/i.test(v.status ?? "")).slice(0, 20);
    return { estado: "sucesso", codigo: marcacoes.length ? "ok_com_marcacoes" : "sem_marcacoes", http_status: 200, caminho: "/vouchers", marcacoes };
  } catch (e) {
    return falha(e instanceof KlingoErro ? e.tipo : "erro_interno", e);
  }
}

/** Ponto único de entrada do executor: cada tipo de operação tem o seu caminho. */
export async function executar(api: KlingoApi, rpc: Rpc, p: Pegar, esps: Esp[]): Promise<Resultado> {
  if (p.operacao.tipo === "ler_vouchers") return await executarConsulta(api, rpc, p);
  if (p.operacao.tipo === "cancelar") return await executarCancelamento(api, rpc, p);
  if (p.operacao.tipo === "marcar" || p.operacao.tipo === "remarcar") return await executarMarcacao(api, rpc, p, esps);
  return falha("tipo_nao_suportado");
}

/** v1.5: nota para a equipe sobre a origem do cadastro (nunca dado do paciente). null = nada a avisar. */
export function notaDoCadastro(cadastro: Resultado["cadastro"], estado: Resultado["estado"]): string | null {
  if (cadastro === "achado_telefone" && (estado === "sucesso" || estado === "incerto"))
    return "Klingo: o CPF informado não foi achado, mas o paciente já tem cadastro (achado por telefone, nascimento e nome). A marcação foi feita no cadastro existente; nenhum pré-cadastro novo foi criado.";
  if (cadastro === "pre_novo_conferir")
    return "Klingo: criado pré-cadastro NOVO, mas já existe cadastro com o MESMO telefone e nascimento e nome diferente do digitado: PROVÁVEL DUPLICADO. Conferir no Klingo e juntar na recepção.";
  if (cadastro === "pre_novo")
    return "Klingo: criado pré-cadastro NOVO (o CPF e telefone + nascimento não acharam cadastro existente). Se o paciente já for da clínica, conferir duplicado e juntar na recepção.";
  return null;
}

export async function executarMarcacao(api: KlingoApi, rpc: Rpc, p: Pegar, esps: Esp[]): Promise<Resultado> {
  const ctx: { cadastro?: Resultado["cadastro"] } = {};
  const r = await marcarInterno(api, rpc, p, esps, ctx);
  return ctx.cadastro ? { ...r, cadastro: ctx.cadastro } : r;
}

async function marcarInterno(api: KlingoApi, rpc: Rpc, p: Pegar, esps: Esp[], ctx: { cadastro?: Resultado["cadastro"] }): Promise<Resultado> {
  const d = p.dados, o = p.oferta, op = p.operacao;
  if (!d.cpf || !d.nascimento || !o || !d.procedimento) return falha("dados_incompletos");
  const remarcacao = op.tipo === "remarcar" ? String(op.detalhe?.remarcacao ?? "") : "";
  if (op.tipo === "remarcar" && !/^\d+$/.test(remarcacao)) return falha("dados_incompletos");
  let tentouMarcar = false;
  try {
    // 1 a 3) identidade, plano e sessão conferida
    const s = await abrirSessao(api, rpc, p, { planoDaOferta: o.plano, liberarNovo: op.tipo !== "remarcar" });
    if (ehResultado(s)) return s;
    ctx.cadastro = s.cadastro;
    const token = s.token, plano = o.plano;

    // remarcar: o voucher antigo precisa estar entre as marcações ATIVAS desta mesma sessão
    if (remarcacao) {
      const ativos = await api.vouchers(token);
      if (!(Array.isArray(ativos) ? ativos : []).some((v) => String(v.id) === remarcacao)) return falha("voucher_antigo_nao_encontrado");
    }

    // 4) o horário ainda existe?
    const ped = pedidoDeHorarios(d.tipo, d.procedimento, esps);
    if (!ped) return falha("fora_do_escopo");
    const pedH = { ...ped, plano, inicio: o.data, fim: o.data };
    // v1.4: o Klingo pode recusar (403) esta consulta com a sessão do pré-cadastro; refaz SEM sessão, com nascimento (e sexo, se houver)
    const buscarDia = async (): Promise<Horario[]> => {
      try { return await api.horarios(pedH, token); } catch (e) {
        if (e instanceof KlingoErro && e.status === 403 && e.tipo === "outro") return await api.horarios({ ...pedH, ...(d.sexo ? { sexo: d.sexo } : {}), nascimento: d.nascimento! });
        throw e;
      }
    };
    const dia: Horario[] = await buscarDia().catch((e) => {
      if (e instanceof KlingoErro && (e.tipo === "sem_medico" || e.tipo === "plano_inativo" || e.tipo === "plano_desconhecido")) return [] as Horario[];
      throw e;
    });
    if (!dia.some((h) => h.id === o.chave)) return { estado: "horario_tomado", codigo: "horario_sumiu" };

    // 5) reservar -> marcar (na remarcação, o Klingo cancela sozinho o voucher antigo quando o novo é criado)
    const m = { horario: o.chave, procedimento: String(o.procedimento), plano, enviarEmail: false, idExterno: op.id, obs: remarcacao ? "Remarcado pelo chat (autoatendimento)" : "Marcado pelo chat (autoatendimento)" };
    let reserva: { id?: number | string } | null = null;
    try { reserva = await api.reservar(token, m); } catch (e) {
      if (e instanceof KlingoErro && e.tipo === "horario_ocupado") return { estado: "horario_tomado", codigo: "horario_ocupado", http_status: e.status, caminho: e.caminho };
      if (e instanceof KlingoErro) return falha(e.tipo, e);
      throw e;
    }
    const soltar = async () => { if (reserva?.id !== undefined) await api.cancelarReserva(token, reserva.id).catch(() => {}); };
    tentouMarcar = true;
    // v1.1: depois da marcação (ou da dúvida), olha o voucher ANTIGO (só na remarcação): ficou ativo, foi cancelado ou não deu para ver
    const olharAntigo = async (): Promise<"ativo" | "cancelado" | "desconhecido" | undefined> => {
      if (!remarcacao) return undefined;
      try {
        const lista = await api.vouchers(token);
        if (!Array.isArray(lista)) return "desconhecido";
        if (lista.some((v) => String(v?.id) === remarcacao)) return "ativo";
        return lista.every((v) => /^\d+$/.test(String(v?.id))) ? "cancelado" : "desconhecido";
      } catch { return "desconhecido"; }
    };
    let v: Record<string, unknown> | null = null;
    try { v = await api.marcar(token, remarcacao ? { ...m, remarcacao } : m); } catch (e) {
      if (e instanceof KlingoErro && e.tipo === "horario_ocupado") { await soltar(); return { estado: "horario_tomado", codigo: "horario_ocupado", http_status: e.status, caminho: e.caminho }; }
      if (e instanceof KlingoErro && !e.incerto) { await soltar(); return falha(e.tipo, e); }
      // INCERTO: o Klingo pode ter criado a marcação. Reconcilia pelas marcações ativas da sessão.
      try {
        const achado = acharVoucher(await api.vouchers(token), op.id, o.data, o.hora, o.procedimento);
        if (achado?.id) return { estado: "sucesso", voucher: achado, codigo: "reconciliado", antigo: await olharAntigo() };
      } catch { /* não deu para conferir: continua incerto */ }
      return { estado: "incerto", codigo: e instanceof KlingoErro ? e.tipo : "erro", antigo: await olharAntigo(), ...(e instanceof KlingoErro ? { http_status: e.status, caminho: e.caminho } : {}) };
    }
    const voucher = resumoVoucher(v);
    if (!voucher.id) {
      try { const achado = acharVoucher(await api.vouchers(token), op.id, o.data, o.hora, o.procedimento); if (achado?.id) return { estado: "sucesso", voucher: achado, codigo: "reconciliado", antigo: await olharAntigo() }; } catch { /* segue incerto */ }
      return { estado: "incerto", codigo: "resposta_sem_voucher", antigo: await olharAntigo() };
    }
    return { estado: "sucesso", voucher: { ...voucher, data: voucher.data ?? o.data, hora: voucher.hora ?? o.hora }, http_status: 200, caminho: "/agenda/horario", antigo: await olharAntigo() };
  } catch (e) {
    if (tentouMarcar) return { estado: "incerto", codigo: e instanceof KlingoErro ? e.tipo : "erro_depois_de_marcar" };
    if (e instanceof KlingoErro && e.tipo === "limite") return falha("limite", e);
    return falha(e instanceof KlingoErro ? e.tipo : "erro_interno", e);
  }
}
