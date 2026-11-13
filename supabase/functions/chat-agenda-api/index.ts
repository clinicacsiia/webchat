// FLUXOGRAMA: entrada (o chat chega ao passo do horário: POST {conversa, token}) -> validação (token da conversa; interruptor klingo_api_horarios = sombra ou sim; 1 procedimento; convênio traduzido para plano do Klingo)
//   -> lógica (cota global; GET /agenda/horarios por 14 dias com sexo e nascimento do paciente; grava as ofertas em klingo_oferta; no modo sombra mede a divergência contra a grade) -> saída ({ok, modo, ofertas}; nunca dado de paciente)
// Versão 1.0 — 12/11/2026 / Mudança: primeira versão (autoatendimento Klingo, etapa 1: horários reais). Só LEITURA: não reserva nem marca nada.
//
// Nunca trava o chat: qualquer problema (limite de chamadas, Klingo lento ou fora, convênio sem tradução) devolve ok:false/motivo e o chat usa a grade, como sempre.
// Quem prova que pode pedir é o token da conversa, por isso a função é publicada SEM exigir JWT (igual à chat-agenda-ao-vivo).
// Secret: KLINGO_APP_TOKEN. Interruptores em config: klingo_api_horarios (nao|sombra|sim), klingo_api_telefones_teste, klingo_api_percentual.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, KlingoApi, KlingoErro } from "./klingo-api.ts";
import { hojeBahia, montarOfertas, pedidoDaApi, somaDias, type DadosConversa, type Esp } from "./oferta.ts";
import { identificar } from "./identificar.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JANELA_DIAS = 14;   // o Klingo recusa períodos maiores que 15 dias (403 "Período excedido. Máximo 15 dias.", provado em 12/11/2026)
const VALIDADE_CACHE_S = 45;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const t0 = Date.now();
  const c = await req.json().catch(() => ({}));
  const conversa = String(c?.conversa ?? ""), tokenConversa = String(c?.token ?? "");
  if (!UUID.test(conversa) || !tokenConversa || tokenConversa.length > 200) return json({ error: "Pedido inválido" }, 400);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { error: eTok } = await supabase.rpc("chat_valida", { p_conversa: conversa, p_token: tokenConversa });
  if (eTok) return json({ error: "Conversa não encontrada" }, 403);

  // Deixa o motivo (ou limpa, com motivo nulo) na conversa: é por ele que a equipe lê POR QUE a marcação sozinha não aconteceu. Nunca leva dado do paciente.
  const motivar = (motivo: string | null, detalhe?: string) => supabase.rpc("klingo_horarios_motivo", { p_conversa: conversa, p_motivo: motivo, p_detalhe: detalhe ?? null }).then(() => {}, () => {});
  const recusar = async (motivo: string, detalhe?: string) => { await motivar(motivo, detalhe); return json({ ok: false, motivo, ...(detalhe ? { detalhe } : {}) }); };
  const medir = (tipo: string, ms?: number) => supabase.rpc("klingo_medir", { p_tipo: tipo, p_n: 1, p_ms: ms ?? null }).then(() => {}, () => {});
  // Interruptor geral (config.klingo_auto): nao = desligado; teste/sim = a API vale (o banco, em klingo_ativo, separa só os telefones de teste de todos); legado = a chave antiga.
  const mestre = String((await supabase.rpc("klingo_mestre")).data ?? "nao");
  if (mestre === "nao") return json({ ok: false, motivo: "desligado" });
  const chave = String((await supabase.rpc("klingo_cfg", { p_chave: "klingo_api_horarios", p_padrao: "nao" })).data ?? "nao");
  const modo = mestre === "legado" ? chave : (chave === "nao" ? "nao" : "sim");
  if (modo !== "sombra" && modo !== "sim") return json({ ok: false, motivo: "desligado" });
  if (modo === "sim") {
    const { data: ativo } = await supabase.rpc("klingo_ativo", { p_conversa: conversa, p_chave: "klingo_api_horarios" });
    if (ativo !== true) return json({ ok: false, motivo: "fora_do_grupo" });
  }
  const tokenKlingo = Deno.env.get("KLINGO_APP_TOKEN");
  if (!tokenKlingo) return await recusar("sem_chave");

  // Modo sombra: o paciente não espera (a medição roda em segundo plano, depois da resposta). Modo sim: o chat espera a lista.
  const trabalho = async (): Promise<Response> => {
  try {
    const { data: d } = await supabase.rpc("klingo_dados_conversa", { p_conversa: conversa });
    const dados = d as DadosConversa | null;
    if (!dados) return await recusar("sem_pedido");
    const { data: esps } = await supabase.from("klingo_especialidade").select("cbos, procedimentos").eq("liberada_api", true);
    const pedido = pedidoDaApi(dados, (esps ?? []) as Esp[]);
    if (!pedido) return await recusar("fora_do_escopo");
    if (!dados.cpf || !dados.nascimento || !dados.plano) return await recusar("dados_incompletos");

    // Cache curto: o chat pede de novo quando a paciente volta de um passo; a mesma lista vale por 45 s.
    const { data: ult } = await supabase.from("klingo_oferta").select("criado_em").eq("conversa_id", conversa).order("criado_em", { ascending: false }).limit(1);
    if (ult?.[0] && Date.now() - Date.parse(ult[0].criado_em) < VALIDADE_CACHE_S * 1000) return json({ ok: true, modo, cache: true });

    const rpc = (n: string, a: Record<string, unknown>) => supabase.rpc(n, a);
    const api = new KlingoApi(tokenKlingo, (u, i) => fetch(u, i), {
      antes: cotaGlobal(rpc, { maxTentativas: 3, maxEsperaMs: 1500 }), aoLimite: async () => { await supabase.rpc("klingo_cota_429"); }, timeoutMs: 8000, tentativas429: 0,
    });

    // Identidade (CPF + nascimento conferidos na API): normalmente já veio do passo anterior; se não, confere agora.
    let ident = dados.identidade;
    if (!ident || ident.situacao === "erro") {
      const r = await identificar(api, dados.cpf, dados.nascimento);
      const { _plano_achado, _contatos_achados, ...limpo } = r;
      await supabase.rpc("klingo_identidade_registrar", { p_cpf: dados.cpf, p_nasc: dados.nascimento, p_r: limpo, p_conversa: conversa });
      ident = { situacao: r.situacao, klingo_id: r.klingo_id ?? null, plano_id: r.plano_id ?? null };
    }
    const { data: pl } = await supabase.rpc("klingo_plano_resolver", { p_operadora: dados.plano, p_plano_cadastro: ident?.situacao === "confere" ? ident.plano_id : null });
    const planoId = (pl as { plano_id?: number | null } | null)?.plano_id ?? null;
    if (!planoId) return await recusar((pl as { motivo?: string } | null)?.motivo ?? "sem_traducao");

    const hoje = hojeBahia();
    const hs = await api.horarios({
      ...pedido, plano: planoId, inicio: hoje, fim: somaDias(hoje, JANELA_DIAS),
      ...(dados.sexo ? { sexo: dados.sexo } : {}), nascimento: dados.nascimento,
    });
    const ofertas = montarOfertas(hs);
    const proc = ofertas.find((o) => o.procedimento)?.procedimento ?? dados.procedimento ?? 0;
    const { data: n, error: eGravar } = await supabase.rpc("klingo_oferta_gravar", { p_conversa: conversa, p_procedimento: proc, p_plano: planoId, p_ofertas: ofertas });
    if (eGravar) throw new Error("gravar_oferta");
    // exame: aprende sozinho se a API tem horário para ele
    if (dados.tipo === "exame" && dados.procedimento) {
      await supabase.from("klingo_proc_api").upsert({ procedimento_id: dados.procedimento, [ofertas.length ? "com_horario_em" : "vazio_em"]: new Date().toISOString() }, { onConflict: "procedimento_id" });
    }
    if (modo === "sombra") await supabase.rpc("klingo_sombra_medir", { p_conversa: conversa });
    const ms = Date.now() - t0;
    await medir("horarios_api_ok", ms);
    await medir(ms < 1000 ? "horarios_ms_lt1s" : ms < 3000 ? "horarios_ms_lt3s" : "horarios_ms_ge3s");
    // A API respondeu, mas sem nenhum horário para este pedido: também é um motivo que a equipe precisa ver.
    if (ofertas.length === 0) await motivar("api_sem_horario"); else await motivar(null);
    return json({ ok: true, modo, ofertas: Number(n ?? 0) });
  } catch (e) {
    const tipo = e instanceof KlingoErro ? e.tipo : "erro";
    // Nunca engolir o erro em silêncio: o log guarda só status, caminho e tipo (nunca corpo, CPF ou nome) e a resposta devolve o motivo técnico.
    const detalhe = e instanceof KlingoErro ? `${e.tipo} (HTTP ${e.status}) em ${e.caminho}${e.resumo ? `: ${e.resumo}` : ""}` : `erro interno: ${(e as Error)?.name ?? "?"}`;
    console.error(`chat-agenda-api: ${detalhe}`);
    // 403 de plano/médico é regra de negócio, não falha técnica: não entra na conta de erros (que faz o sistema recuar sozinho) e a equipe é avisada do motivo.
    if (e instanceof KlingoErro && (e.tipo === "sem_medico" || e.tipo === "plano_inativo" || e.tipo === "plano_desconhecido")) {
      await medir("horarios_api_regra");
      return await recusar(e.tipo, e.resumo);
    }
    await medir(tipo === "limite" ? "horarios_api_limite" : "horarios_api_erro");
    return await recusar(tipo === "limite" ? "limite" : "indisponivel", detalhe);
  }
  };
  if (modo === "sombra") {
    const er = (globalThis as unknown as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
    if (er) { er.waitUntil(trabalho().catch(() => {})); return json({ ok: true, modo, assincrono: true }); }
  }
  return await trabalho();
});
