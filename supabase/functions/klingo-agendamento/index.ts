// FLUXOGRAMA: entrada (POST JSON {"acao": "...", ...} vindo da página pública /agendamento/, sem login) -> validação (tamanho do corpo, ação conhecida, campos conferidos um a um,
//   CPF com dígito verificador, travas por CPF) -> lógica (regras.ts: catálogos e horários só leem; ações do paciente conferem CPF + nascimento no Klingo antes e depois do login;
//   toda chamada passa pela cota global do banco) -> saída (JSON enxuto; nunca corpo de erro do Klingo, CPF, RG, foto nem contato sem máscara; nada de paciente vai para log)
// Versão 1.2 — 13/11/2026 / Mudança: acrescenta a área da família (ações fam_*, familia.ts; precisa dos secrets FAMILIA_CHAVE e FAMILIA_SYNC_CHAVE e do arquivo supabase/familia-agendamento.sql aplicado).
// Versão 1.1 — 13/11/2026 / Mudança: acrescenta verificar_horario, resultado por accession, entrada por telefone, conta do portal, totais do dia e API de telefonia (a equipe), tudo menos dinheiro. A 1.0 era a primeira versão.
//
// Publicar com verify_jwt=false (a página é pública; quem protege é a conferência de CPF + nascimento e as travas em regras.ts).
// Secrets: KLINGO_APP_TOKEN (o mesmo das outras funções) e, opcionais e DESLIGADOS por padrão: AGENDAMENTO_RESULTADO=1 (entrega de laudo), AGENDAMENTO_TELEFONE=1 (entrar por telefone + nascimento),
// AGENDAMENTO_PORTAL=1 (conta e senha do portal) e AGENDAMENTO_EQUIPE_CHAVE=<texto longo> (libera as ações equipe_* para quem mandar o mesmo valor no cabeçalho x-equipe-chave). Tabela usada: klingo_identidade (já existe) e, na área da família, as do arquivo supabase/familia-agendamento.sql; RPCs: klingo_hash, klingo_cota_pegar, klingo_cota_429,
// klingo_identidade_registrar, klingo_pre_gravar. NÃO cria tabela nem função no banco.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, KlingoApi } from "./api.ts";
import { type Banco, type Ctx } from "./regras.ts";
import { type FamiliaDb, tratarTudo } from "./familia.ts";

const ORIGENS = ["https://clinicacsiia.github.io", "http://localhost:8000", "http://localhost:8080", "http://127.0.0.1:8000", "http://127.0.0.1:8080"];
const MAX_CORPO = 16 * 1024;

const cors = (origem: string | null): Record<string, string> => ({
  ...(origem && ORIGENS.includes(origem) ? { "Access-Control-Allow-Origin": origem, Vary: "Origin" } : {}),
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info, x-equipe-chave",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
});
const json = (b: unknown, status: number, origem: string | null) => new Response(JSON.stringify(b), { status, headers: { ...cors(origem), "Content-Type": "application/json" } });
const dataSP = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());

// Marca dos pré-cadastros criados por esta página (klingo_pre_gravar exige um uuid de operação; aqui é sempre o mesmo): serve para contar o teto diário.
const OPERACAO_PAGINA = "00000000-0000-4000-8000-0000000a9e11";

const cache = new Map<string, { ate: number; v: unknown }>();
/** Comparação em tempo constante (a chave da equipe não vaza por tempo de resposta). */
const igual = (a: string, b: string) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

/** Liga as funções do arquivo supabase/familia-agendamento.sql ao que a família precisa (cada método é uma chamada ao banco; erro do banco vira exceção e a ação responde 500 sem texto do erro). */
function familiaDb(rpc: (n: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>): FamiliaDb {
  const chamar = async <T>(nome: string, args: Record<string, unknown>): Promise<T> => { const { data, error } = await rpc(nome, args); if (error) throw new Error(nome); return data as T; };
  return {
    aparelhoCriar: (h, a) => chamar("familia_aparelho_criar", { p_token_hash: h, p_apelido: a ?? null }),
    aparelhoLer: (h) => chamar("familia_aparelho_ler", { p_token_hash: h }),
    aparelhoDesligar: async (id) => { await chamar("familia_aparelho_desligar", { p_aparelho: id }); },
    pessoaGuardar: (p) => chamar("familia_pessoa_guardar", { p }),
    pessoaLer: (a, p) => chamar("familia_pessoa_ler", { p_aparelho: a, p_pessoa: p }),
    pessoaLerServico: (p) => chamar("familia_pessoa_ler_servico", { p_pessoa: p }),
    pessoasPorPar: (h) => chamar("familia_pessoa_por_par", { p_par_hash: h }),
    pessoasNovasHoje: () => chamar("familia_pessoas_novas_hoje", {}),
    vincular: (a, p, papel, porta, nivel = 1, lib = null) => chamar("familia_vincular", { p_aparelho: a, p_pessoa: p, p_papel: papel, p_porta: porta, p_nivel: nivel, p_liberado_em: lib }),
    conviteCriar: (a, ps, h) => chamar("familia_convite_criar", { p_aparelho: a, p_pessoas: ps, p_codigo_hash: h }),
    conviteUsar: (h, a) => chamar("familia_convite_usar", { p_codigo_hash: h, p_aparelho: a }),
    pedirPorDados: (a, p, papel) => chamar("familia_pedir_por_dados", { p_aparelho: a, p_pessoa: p, p_papel: papel }),
    avisos: (a) => chamar("familia_avisos", { p_aparelho: a }),
    avisoResponder: (a, id, lib) => chamar("familia_aviso_responder", { p_aparelho: a, p_aviso: id, p_liberar: lib }),
    marcacaoGravar: async (m) => { await chamar("familia_marcacao_gravar", { p: m }); },
    acompanhar: (a) => chamar("familia_acompanhar", { p_aparelho: a }),
    previsaoLaudo: (p) => chamar("familia_previsao_laudo", { p_procedimento: p }),
    historico: (ps) => chamar("familia_historico", { p_pessoas: ps }),
    popularidade: (d) => chamar("agenda_popularidade", { p_dias: d }),
    pessoasAtivas: (m) => chamar("familia_pessoas_ativas", { p_minutos: m }),
    marcacoesAbertas: (p) => chamar("familia_marcacoes_abertas", { p_pessoa: p }),
    planosEmUso: () => chamar("familia_planos_em_uso", {}),
    config: () => chamar("familia_config", {}),
    risco: (a) => chamar("familia_risco", { p_aparelho: a }),
    alertar: async (t, a, p, d) => { await chamar("familia_alertar", { p_tipo: t, p_aparelho: a, p_pessoa: p, p_detalhe: d ?? {} }); },
    segurar: (g, sl, seg, est) => chamar("agenda_segurar", { p_grupo: g, p_slots: sl, p_segundos: seg, p_estado: est ?? "segurando" }),
    segurarMarcar: async (g, seg, v) => { await chamar("agenda_segura_marcar", { p_grupo: g, p_segundos: seg, p_vouchers: v ?? {} }); },
    liberarVoucher: async (v) => { await chamar("agenda_segura_liberar", { p_voucher: v }); },
    soltar: async (g) => { await chamar("agenda_segura_soltar", { p_grupo: g }); },
    emUso: (sl, ig) => chamar("agenda_em_uso", { p_slots: sl, p_ignorar_grupo: ig ?? null }),
    esperaEntrar: (a, p, k, pr, u, v, d, h) => chamar("espera_entrar", { p_aparelho: a, p_pessoa: p, p_need_key: k, p_params: pr, p_urgencia: u, p_voucher: v ?? null, p_data: d ?? null, p_hora: h ?? null }),
    esperaSair: (a, id) => chamar("espera_sair", { p_aparelho: a, p_id: id }),
    esperaListar: (a) => chamar("espera_listar", { p_aparelho: a }),
    esperaNecessidades: (m) => chamar("espera_necessidades", { p_max: m }),
    esperaLida: async (k) => { await chamar("espera_lida", { p_need_key: k }); },
    esperaCandidatas: (k) => chamar("espera_candidatas", { p_need_key: k }),
    esperaOfertar: (id, sl, seg) => chamar("espera_ofertar", { p_id: id, p_slot: sl, p_segundos: seg }),
    esperaExpirar: () => chamar("espera_expirar", {}),
    esperaResponder: (a, id, ac) => chamar("espera_responder", { p_aparelho: a, p_id: id, p_aceita: ac }),
    esperaConcluir: async (id, v) => { await chamar("espera_concluir", { p_id: id, p_voucher: v }); },
    esperaFalhou: async (id) => { await chamar("espera_falhou", { p_id: id }); },
    acessoRegistrar: (a, p, v) => chamar("familia_acesso_registrar", { p_aparelho: a, p_pessoa: p, p_voucher: v }),
    cacheLer: (c) => chamar("agenda_cache_ler", { p_chave: c }),
    cacheGravar: async (c, d, s) => { await chamar("agenda_cache_gravar", { p_chave: c, p_dados: d, p_valido_seg: s }); },
    filaPedir: async (c, p, pr) => { await chamar("agenda_fila_pedir", { p_chave: c, p_params: p, p_prioridade: pr }); },
    filaPegar: async (m) => (await chamar<Array<{ id: number; chave: string; params: Record<string, unknown> }>>("agenda_fila_pegar", { p_max: m })) ?? [],
    filaFim: async (id, okk, erro, refazerSeg) => { await chamar("agenda_fila_fim", { p_id: id, p_ok: okk, p_erro: erro ?? null, p_refazer_em: refazerSeg ? `${refazerSeg} seconds` : null }); },
  };
}

Deno.serve(async (req: Request) => {
  const origem = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origem) });
  if (req.method !== "POST") return json({ ok: false, motivo: "metodo" }, 405, origem);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ ok: false, motivo: "sem_configuracao" }, 500, origem);

  const texto = await req.text().catch(() => "");
  if (texto.length > MAX_CORPO) return json({ ok: false, motivo: "corpo_grande" }, 413, origem);
  let corpo: Record<string, unknown>;
  try { const x = JSON.parse(texto); if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("x"); corpo = x; } catch { return json({ ok: false, motivo: "json_invalido" }, 400, origem); }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const rpc = (n: string, a: Record<string, unknown>) => supabase.rpc(n, a);
  const hash = async (t: string) => { const { data, error } = await rpc("klingo_hash", { p_texto: t }); if (error || typeof data !== "string") throw new Error("hash"); return data; };

  const db: Banco = {
    hash,
    async divergentesRecentes(cpfHash) {
      const desde = new Date(Date.now() - 3_600_000).toISOString();
      const { count, error } = await supabase.from("klingo_identidade").select("id", { count: "exact", head: true }).eq("cpf_hash", cpfHash).eq("situacao", "divergente").gte("conferido_em", desde);
      if (error) throw new Error("tentativas");   // na dúvida, NÃO libera (a ação falha com 500)
      return count ?? 0;
    },
    async registrarIdentidade(cpf, nascimento, r) {
      await rpc("klingo_identidade_registrar", { p_cpf: cpf, p_nasc: nascimento, p_r: r, p_conversa: null });
    },
    async preDoPar(cpf, nascimento) {
      const chave = await hash(`${cpf}|${nascimento}`);
      const { data } = await supabase.from("klingo_identidade").select("klingo_id").eq("chave", chave).eq("tipo", "pre").maybeSingle();
      return data ? { klingo_id: (data as { klingo_id: string | null }).klingo_id } : null;
    },
    async reservarPre(cpf, nascimento) {
      const chave = await hash(`${cpf}|${nascimento}`), cpfHash = await hash(cpf);
      const { error } = await supabase.from("klingo_identidade").insert({ chave, cpf_hash: cpfHash, tipo: "pre", klingo_id: null, situacao: "pre_cadastro" });
      if (!error) return { criado: true, mesmoPar: true, klingo_id: null, idadeMin: 0 };
      if ((error as { code?: string }).code !== "23505") throw new Error("reservar_pre");
      const { data } = await supabase.from("klingo_identidade").select("chave, klingo_id, conferido_em").eq("cpf_hash", cpfHash).eq("tipo", "pre").limit(1).maybeSingle();
      const d = data as { chave: string; klingo_id: string | null; conferido_em: string } | null;
      return { criado: false, mesmoPar: d?.chave === chave, klingo_id: d?.klingo_id ?? null, idadeMin: d ? (Date.now() - Date.parse(d.conferido_em)) / 60_000 : 0 };
    },
    async gravarPre(cpf, nascimento, klingoId) {
      const { error } = await rpc("klingo_pre_gravar", { p_op: OPERACAO_PAGINA, p_cpf: cpf, p_nasc: nascimento, p_klingo_id: klingoId });
      if (error) throw new Error("gravar_pre");
    },
    async soltarPre(cpf, nascimento) {
      await supabase.from("klingo_identidade").delete().eq("chave", await hash(`${cpf}|${nascimento}`)).eq("tipo", "pre").is("klingo_id", null);
    },
    async registrarTentativa(chave) {
      // tentativa recusada por telefone ou e-mail+senha: uma linha por tentativa (chave única por uuid); só hashes, sem telefone, e-mail nem senha
      const { error } = await supabase.from("klingo_identidade").insert({ chave: await hash(`${chave}|${crypto.randomUUID()}`), cpf_hash: await hash(chave), tipo: null, klingo_id: null, situacao: "divergente" });
      if (error) throw new Error("tentativa");   // na dúvida a ação falha (500); não libera
    },
    async precadastrosRecentes() {
      const desde = new Date(Date.now() - 86_400_000).toISOString();
      const { count } = await supabase.from("klingo_identidade").select("id", { count: "exact", head: true }).eq("tipo", "pre").or(`criado_pela_operacao.is.null,criado_pela_operacao.eq.${OPERACAO_PAGINA}`).gte("conferido_em", desde);
      return count ?? 0;
    },
  };

  const api = new KlingoApi(token, (u, i) => fetch(u, i), { antes: cotaGlobal(rpc), aoLimite: async () => { await supabase.rpc("klingo_cota_429"); } });
  const chaveEquipe = Deno.env.get("AGENDAMENTO_EQUIPE_CHAVE") ?? "", enviada = req.headers.get("x-equipe-chave") ?? "";
  const ctx: Ctx = {
    api, db, hoje: dataSP, agora: () => Date.now(), uuid: () => crypto.randomUUID(), cache,
    resultado: Deno.env.get("AGENDAMENTO_RESULTADO") === "1", telefone: Deno.env.get("AGENDAMENTO_TELEFONE") === "1", portal: Deno.env.get("AGENDAMENTO_PORTAL") === "1",
    equipe: chaveEquipe.length >= 20 && igual(chaveEquipe, enviada),   // sem o secret (ou curto demais) a área da equipe fica fechada
  };
  // A área da família só liga com os dois secrets: FAMILIA_CHAVE (32 bytes em base64, cifra CPF e nascimento) e as tabelas do arquivo supabase/familia-agendamento.sql aplicadas.
  const fam = { db: Deno.env.get("FAMILIA_CHAVE") ? familiaDb(rpc) : null, chave: Deno.env.get("FAMILIA_CHAVE") ?? null, chaveSync: Deno.env.get("FAMILIA_SYNC_CHAVE") ?? null };
  try {
    const r = await tratarTudo({ ...ctx, fam }, corpo);
    return json(r.corpo, r.status, origem);
  } catch {
    return json({ ok: false, motivo: "erro" }, 500, origem);   // nunca devolve a mensagem do erro
  }
});
