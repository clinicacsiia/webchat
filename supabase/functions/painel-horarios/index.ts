// FLUXOGRAMA: entrada (POST {conversa, janela?} do painel, com o login da equipe) -> validação (JWT; papel admin ou atendente; conversa é UUID)
//   -> processamento (lê os dados da conversa; confere o convênio; GET /agenda/horarios por 14 dias, com a cota global) -> persistência (NENHUMA: só leitura, não grava oferta nem consulta)
//   -> saída ({ok, estado, dias[{data, itens[{hora, profissional, unidade}]}]} ou {ok:false, motivo}); nunca nome, CPF, telefone nem corpo de erro do Klingo.
// Versão 1.0 — 16/11/2026 / Mudança: primeira versão (Etapa 1 do plano docs/plano-painel-agenda-2026-11-16.md: a atendente vê os horários reais da API dentro da conversa).
// Publicada COM verify_jwt (o painel chama por db.functions.invoke, que leva o login). Secret: KLINGO_APP_TOKEN.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, KlingoApi, KlingoErro } from "./klingo-api.ts";
import { diagnosticar, hojeBahia, horaBahia, pedidoDaApi, somaDias, type DadosConversa, type Esp } from "./oferta.ts";
import { identificar } from "./identificar.ts";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JANELA_DIAS = 14;   // o Klingo recusa períodos maiores que 15 dias
const MAX_HORARIOS = 80;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const c = await req.json().catch(() => ({}));
  const conversa = String(c?.conversa ?? "");
  const janela = Math.min(Math.max(Number.isInteger(c?.janela) ? Number(c.janela) : 0, 0), 3);
  if (!UUID.test(conversa)) return json({ error: "Pedido inválido" }, 400);

  // Quem pede precisa ser admin ou atendente ativo (o papel vem do login, nunca do corpo do pedido).
  const url = Deno.env.get("SUPABASE_URL")!;
  const usuario = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: papel } = await usuario.rpc("papel_atual");
  if (papel !== "admin" && papel !== "atendente") return json({ error: "Sem permissão" }, 403);

  const supabase = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const falha = (motivo: string, extra: Record<string, unknown> = {}) => json({ ok: false, motivo, ...extra });
  const tokenKlingo = Deno.env.get("KLINGO_APP_TOKEN");
  if (!tokenKlingo) return falha("sem_chave");

  try {
    const { data: d } = await supabase.rpc("klingo_dados_conversa", { p_conversa: conversa });
    const dados = d as DadosConversa | null;
    if (!dados) return falha("sem_pedido");
    const { data: esps } = await supabase.from("klingo_especialidade").select("cbos, procedimentos").eq("liberada_api", true);
    const pedido = pedidoDaApi(dados, (esps ?? []) as Esp[]);
    if (!pedido) return falha(dados.n_procedimentos > 1 ? "varios_procedimentos" : dados.procedimento ? "fora_do_escopo" : "sem_pedido");
    const faltando = [!dados.cpf && "CPF", !dados.nascimento && "data de nascimento", !dados.plano && "convênio"].filter(Boolean);
    if (faltando.length) return falha("dados_incompletos", { faltando });

    const rpc = (n: string, a: Record<string, unknown>) => supabase.rpc(n, a);
    const api = new KlingoApi(tokenKlingo, (u, i) => fetch(u, i), {
      antes: cotaGlobal(rpc, { maxTentativas: 3, maxEsperaMs: 1500 }), aoLimite: async () => { await supabase.rpc("klingo_cota_429"); }, timeoutMs: 8000, tentativas429: 0,
    });

    // Identidade: usa o que o chat já conferiu; se não houver, confere agora na API (sem gravar).
    let ident = dados.identidade;
    if (!ident || ident.situacao === "erro") {
      const r = await identificar(api, dados.cpf!, dados.nascimento!);
      ident = { situacao: r.situacao, klingo_id: r.klingo_id ?? null, plano_id: r.plano_id ?? null };
    }
    const { data: pl } = await supabase.rpc("klingo_plano_resolver", { p_operadora: dados.plano, p_plano_cadastro: ident?.situacao === "confere" ? ident.plano_id : null });
    const planoId = (pl as { plano_id?: number | null } | null)?.plano_id ?? null;
    if (!planoId) return falha((pl as { motivo?: string } | null)?.motivo ?? "sem_traducao");

    const hoje = hojeBahia(), inicio = somaDias(hoje, janela * (JANELA_DIAS + 1)), fim = somaDias(inicio, JANELA_DIAS);
    const bruto = await api.horariosBruto({
      ...pedido, plano: planoId, inicio, fim,
      ...(dados.sexo ? { sexo: dados.sexo } : {}), nascimento: dados.nascimento!,
    });
    const dg = diagnosticar(bruto, hoje, horaBahia());
    if (dg.resultado === "estrutura_invalida") return falha("indisponivel", { detalhe: "resposta inesperada do Klingo" });

    const porDia = new Map<string, Array<{ hora: string; profissional: string | null; unidade: string | null; ordem_chegada: boolean }>>();
    for (const o of dg.ofertas.slice(0, MAX_HORARIOS)) {
      if (!porDia.has(o.data)) porDia.set(o.data, []);
      porDia.get(o.data)!.push({ hora: o.hora, profissional: o.profissional, unidade: o.unidade, ordem_chegada: o.ordem_chegada });
    }
    return json({
      ok: true, estado: dg.ofertas.length ? "com_horarios" : "sem_horarios", tipo: dados.tipo, janela, de: inicio, ate: fim,
      total: dg.ofertas.length, cortado: dg.ofertas.length > MAX_HORARIOS, dias: [...porDia].map(([data, itens]) => ({ data, itens })),
    });
  } catch (e) {
    // Regras do Klingo (convênio inativo/suspenso, sem médico, idade/sexo) não são falha técnica: a atendente precisa saber o motivo.
    if (e instanceof KlingoErro && (e.tipo === "sem_medico" || e.tipo === "plano_inativo" || e.tipo === "plano_desconhecido")) return falha(e.tipo, { detalhe: e.resumo });
    if (e instanceof KlingoErro && e.status === 403 && /idade|sexo|dispon[ií]vel apenas/i.test(e.resumo ?? "")) return falha("regra_paciente", { detalhe: e.resumo });
    console.error(`painel-horarios: ${e instanceof KlingoErro ? `${e.tipo} (HTTP ${e.status}) em ${e.caminho}` : `erro interno: ${(e as Error)?.name ?? "?"}`}`);
    return falha(e instanceof KlingoErro && e.tipo === "limite" ? "limite" : "indisponivel");
  }
});
