// O coração da marcação automática (sem Deno, para testar com um Klingo de mentira). Versão 1.0 — 12/11/2026.
//
// Recebe SÓ o que o banco entregou ao executor (a operação, os dados já validados da conversa e a oferta que o Klingo fez a ela) e devolve o resultado.
// Ordem, sem pular nada (cada passo que falha para tudo e devolve um código interno; nunca o corpo da resposta do Klingo):
//   1) identidade: GET /paciente/cpf; o nascimento tem que bater; só id definitivo "P…"; paciente novo só com a liberação do pré-cadastro e a trava por CPF
//   2) plano: o do cadastro/padrão, o MESMO da oferta
//   3) login com o id EXATO do Klingo e conferência da sessão (id, nascimento e, no pré-cadastro, o nome)
//   4) o horário ainda existe? (GET /agenda/horarios do dia com a sessão); se não, "horário tomado"
//   5) reservar -> marcar (id_externo = id da operação); se o resultado for incerto, reconcilia por GET /vouchers; se não achar, INCERTO (a equipe confere ANTES de marcar de novo)
// Cancelar e remarcar (etapa 4): mesma identidade e mesma sessão conferida; só mexem em voucher que está entre as marcações ATIVAS da sessão do próprio paciente.
import { cadastroParaComparar, camposDivergentes, type Horario, type KlingoApi, KlingoErro, resumoPaciente, resumoVoucher, semAcento, dataIso } from "./klingo-api.ts";

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

type Sessao = { token: string; idLogin: string; tipoId: "definitivo" | "pre"; planoCadastro: number | null };

/**
 * Passos comuns a toda operação em nome do paciente: identidade na API, plano (se exigido) e sessão conferida.
 * Devolve a sessão ou o Resultado que explica por que parou (nunca segue com identidade duvidosa).
 */
async function abrirSessao(api: KlingoApi, rpc: Rpc, p: Pegar, o: { planoDaOferta?: number; liberarNovo?: boolean } = {}): Promise<Sessao | Resultado> {
  const d = p.dados, op = p.operacao;
  let idLogin: string, tipoId: "definitivo" | "pre", planoCadastro: number | null = null;
  let pac: Record<string, unknown> | null = null;
  try { pac = await api.pacientePorCpf(d.cpf!) as Record<string, unknown> | null; } catch (e) {
    if (!(e instanceof KlingoErro && e.tipo === "paciente_nao_identificado")) throw e;
  }
  const s = pac ? resumoPaciente(pac) : null;
  if (s?.id) {
    if (s.nascimento !== d.nascimento) {
      await rpc("klingo_identidade_registrar", { p_cpf: d.cpf, p_nasc: d.nascimento, p_r: { situacao: "divergente" }, p_conversa: null });
      return falha("nascimento_divergente");
    }
    if (!/^P\d+$/.test(s.id)) return falha("sem_id_definitivo");
    // nome, mãe, sexo, telefone e e-mail digitados x cadastro do Klingo (o Klingo manda): 1 divergente = a equipe valida; 2 ou mais = o paciente vai à clínica
    const dif = camposDivergentes(cadastroParaComparar(pac), d);
    if (dif.length >= 2) { await rpc("klingo_identidade_registrar", { p_cpf: d.cpf, p_nasc: d.nascimento, p_r: { situacao: "divergente" }, p_conversa: null }); return falha("divergencia_2:" + dif.join(",")); }
    if (dif.length === 1) return falha("divergencia_1:" + dif[0]);
    idLogin = s.id; tipoId = "definitivo"; planoCadastro = s.planoId;
    await rpc("klingo_identidade_registrar", { p_cpf: d.cpf, p_nasc: d.nascimento, p_r: { situacao: "confere", klingo_id: s.id, faltando: s.faltando, plano_id: s.planoId }, p_conversa: null });
  } else {
    // paciente novo (só cria marcação; cancelar/remarcar de quem nem cadastro tem não faz sentido)
    if (o.liberarNovo === false) return falha("cadastro_nao_encontrado");
    const liberado = dado<boolean>(await rpc("klingo_ativo", { p_conversa: op.conversa_id, p_chave: "klingo_api_pre_cadastro" }));
    if (!liberado) return falha("paciente_novo_nao_liberado");
    if (!d.nome || !d.sexo) return falha("dados_incompletos");
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
      idLogin = novo.id; tipoId = "pre";
    } else return { estado: "incerto", codigo: "registro_em_andamento_ou_incerto" };
  }
  if (o.planoDaOferta !== undefined) {
    const pl = dado<{ plano_id?: number | null; motivo?: string }>(await rpc("klingo_plano_resolver", { p_operadora: d.plano, p_plano_cadastro: planoCadastro }));
    const plano = pl?.plano_id ?? null;
    if (!plano) return falha(pl?.motivo ?? "sem_traducao");
    if (plano !== o.planoDaOferta) return falha("plano_mudou_depois_da_oferta");
  }
  const { token, user } = await api.login(idLogin);
  const mesmoNome = tipoId === "definitivo" || semAcento(user.nome) === semAcento(d.nome);
  if (String(user.id ?? "") !== idLogin || dataIso(user.nascimento) !== d.nascimento || !mesmoNome) return falha("sessao_nao_confere");
  if (tipoId === "pre" && user.id_paciente) return falha("pre_cadastro_ja_definitivo");
  return { token, idLogin, tipoId, planoCadastro };
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

/** Ponto único de entrada do executor: cada tipo de operação tem o seu caminho. */
export async function executar(api: KlingoApi, rpc: Rpc, p: Pegar, esps: Esp[]): Promise<Resultado> {
  if (p.operacao.tipo === "cancelar") return await executarCancelamento(api, rpc, p);
  if (p.operacao.tipo === "marcar" || p.operacao.tipo === "remarcar") return await executarMarcacao(api, rpc, p, esps);
  return falha("tipo_nao_suportado");
}

export async function executarMarcacao(api: KlingoApi, rpc: Rpc, p: Pegar, esps: Esp[]): Promise<Resultado> {
  const d = p.dados, o = p.oferta, op = p.operacao;
  if (!d.cpf || !d.nascimento || !o || !d.procedimento) return falha("dados_incompletos");
  const remarcacao = op.tipo === "remarcar" ? String(op.detalhe?.remarcacao ?? "") : "";
  if (op.tipo === "remarcar" && !/^\d+$/.test(remarcacao)) return falha("dados_incompletos");
  let tentouMarcar = false;
  try {
    // 1 a 3) identidade, plano e sessão conferida
    const s = await abrirSessao(api, rpc, p, { planoDaOferta: o.plano, liberarNovo: op.tipo !== "remarcar" });
    if (ehResultado(s)) return s;
    const token = s.token, plano = o.plano;

    // remarcar: o voucher antigo precisa estar entre as marcações ATIVAS desta mesma sessão
    if (remarcacao) {
      const ativos = await api.vouchers(token);
      if (!(Array.isArray(ativos) ? ativos : []).some((v) => String(v.id) === remarcacao)) return falha("voucher_antigo_nao_encontrado");
    }

    // 4) o horário ainda existe?
    const ped = pedidoDeHorarios(d.tipo, d.procedimento, esps);
    if (!ped) return falha("fora_do_escopo");
    const dia: Horario[] = await api.horarios({ ...ped, plano, inicio: o.data, fim: o.data }, token).catch((e) => {
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
    let v: Record<string, unknown> | null = null;
    try { v = await api.marcar(token, remarcacao ? { ...m, remarcacao } : m); } catch (e) {
      if (e instanceof KlingoErro && e.tipo === "horario_ocupado") { await soltar(); return { estado: "horario_tomado", codigo: "horario_ocupado", http_status: e.status, caminho: e.caminho }; }
      if (e instanceof KlingoErro && !e.incerto) { await soltar(); return falha(e.tipo, e); }
      // INCERTO: o Klingo pode ter criado a marcação. Reconcilia pelas marcações ativas da sessão.
      try {
        const achado = acharVoucher(await api.vouchers(token), op.id, o.data, o.hora, o.procedimento);
        if (achado?.id) return { estado: "sucesso", voucher: achado, codigo: "reconciliado" };
      } catch { /* não deu para conferir: continua incerto */ }
      return { estado: "incerto", codigo: e instanceof KlingoErro ? e.tipo : "erro", ...(e instanceof KlingoErro ? { http_status: e.status, caminho: e.caminho } : {}) };
    }
    const voucher = resumoVoucher(v);
    if (!voucher.id) {
      try { const achado = acharVoucher(await api.vouchers(token), op.id, o.data, o.hora, o.procedimento); if (achado?.id) return { estado: "sucesso", voucher: achado, codigo: "reconciliado" }; } catch { /* segue incerto */ }
      return { estado: "incerto", codigo: "resposta_sem_voucher" };
    }
    return { estado: "sucesso", voucher: { ...voucher, data: voucher.data ?? o.data, hora: voucher.hora ?? o.hora }, http_status: 200, caminho: "/agenda/horario" };
  } catch (e) {
    if (tentouMarcar) return { estado: "incerto", codigo: e instanceof KlingoErro ? e.tipo : "erro_depois_de_marcar" };
    if (e instanceof KlingoErro && e.tipo === "limite") return falha("limite", e);
    return falha(e instanceof KlingoErro ? e.tipo : "erro_interno", e);
  }
}
