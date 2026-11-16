// FLUXOGRAMA: entrada (POST JSON {"acao":"listar"|"baixar","token":<código do aparelho>,"id":<marcação>} vindo da página minha-vez/ do paciente) -> validação (tamanho do corpo; o BANCO confere o aparelho e o PIN dos
//   últimos 30 minutos; cada pessoa só entra depois de CPF + nascimento + nome conferidos no Klingo) -> lógica (laudos.ts: lista as marcações atendidas, confere o Klingo a cada download) -> saída (JSON enxuto;
//   o PDF vai só na resposta do download, em base64; nunca é guardado nem registrado em log; erro do Klingo nunca vira laudo liberado)
// Versão 1.0 — 16/11/2026 / Mudança: primeira versão. Publicar SÓ depois de aplicar supabase/laudos-no-app.sql.
//
// Publicar com verify_jwt=false (a página não tem login do Supabase; quem protege é o código do aparelho com PIN, conferido pelo banco).
// Secrets: KLINGO_APP_TOKEN (o mesmo das outras funções). RPCs usadas (todas só do service_role): app_laudos_contexto, app_laudos_pessoa_gravar, app_laudos_itens_gravar, app_laudos_a_checar,
// app_laudos_estado, app_laudos_lista, app_laudos_pode, app_evento_gravar, klingo_hash, klingo_cota_pegar, klingo_identidade_registrar.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, KlingoApi } from "./api.ts";
import { type Banco, type Ctx, tratar } from "./laudos.ts";

const ORIGENS = ["https://clinicacsiia.github.io", "http://localhost:8000", "http://localhost:8080", "http://127.0.0.1:8000", "http://127.0.0.1:8080"];
const MAX_CORPO = 4 * 1024;

const cors = (origem: string | null): Record<string, string> => ({
  ...(origem && ORIGENS.includes(origem) ? { "Access-Control-Allow-Origin": origem, Vary: "Origin" } : {}),
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
});
const json = (b: unknown, status: number, origem: string | null) => new Response(JSON.stringify(b), { status, headers: { ...cors(origem), "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  const origem = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origem) });
  if (req.method !== "POST") return json({ ok: false, erro: "metodo" }, 405, origem);
  const appToken = Deno.env.get("KLINGO_APP_TOKEN");
  if (!appToken) return json({ ok: false, erro: "sem_configuracao", mensagem: "Não foi possível consultar os laudos agora." }, 500, origem);

  const texto = await req.text().catch(() => "");
  if (texto.length > MAX_CORPO) return json({ ok: false, erro: "corpo_grande" }, 413, origem);
  let corpo: Record<string, unknown>;
  try { const x = JSON.parse(texto); if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error("x"); corpo = x; } catch { return json({ ok: false, erro: "json_invalido" }, 400, origem); }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const rpc = async (nome: string, args: Record<string, unknown>) => {
    const { data, error } = await supabase.rpc(nome, args);
    if (error) throw new Error("rpc");   // nunca repassa a mensagem do banco
    return data;
  };
  const obj = (d: unknown) => (d && typeof d === "object" && !Array.isArray(d) ? d as Record<string, unknown> : {});
  const db: Banco = {
    async contexto(token, renova) { return obj(await rpc("app_laudos_contexto", { p_token: token, p_renova: renova })) as Awaited<ReturnType<Banco["contexto"]>>; },
    async pessoaGravar(pac, pessoa, situacao, klingoId) { await rpc("app_laudos_pessoa_gravar", { p_pac: pac, p_pessoa: pessoa, p_situacao: situacao, p_klingo_id: klingoId }); },
    async itensGravar(pac, pessoa, itens) { await rpc("app_laudos_itens_gravar", { p_pac: pac, p_pessoa: pessoa, p_itens: itens }); },
    async aChecar(pac, max) { const d = await rpc("app_laudos_a_checar", { p_pac: pac, p_max: max }); return Array.isArray(d) ? d.map(String) : []; },
    async estado(pac, marcacao, pronto) { await rpc("app_laudos_estado", { p_pac: pac, p_marcacao: marcacao, p_pronto: pronto }); },
    async lista(pac) { return obj(await rpc("app_laudos_lista", { p_pac: pac })); },
    async pode(token, marcacao) { return obj(await rpc("app_laudos_pode", { p_token: token, p_marcacao: marcacao })) as Awaited<ReturnType<Banco["pode"]>>; },
    async evento(pac, tipo) { await rpc("app_evento_gravar", { p_pac: pac, p_tipo: tipo }); },
    async divergentesRecentes(cpf) {
      const hash = await rpc("klingo_hash", { p_texto: cpf });
      if (typeof hash !== "string") throw new Error("hash");
      const desde = new Date(Date.now() - 3_600_000).toISOString();
      const { count, error } = await supabase.from("klingo_identidade").select("id", { count: "exact", head: true }).eq("cpf_hash", hash).eq("situacao", "divergente").gte("conferido_em", desde);
      if (error) throw new Error("conta");   // na dúvida, trava
      return count ?? 0;
    },
    async registrarIdentidade(cpf, nascimento, r) { await rpc("klingo_identidade_registrar", { p_cpf: cpf, p_nasc: nascimento, p_r: r }); },
  };
  const api = new KlingoApi(appToken, (u, i) => fetch(u, i), { antes: cotaGlobal((n, a) => supabase.rpc(n, a)), timeoutMs: 25_000 });
  const ctx: Ctx = { api, db };
  try {
    const r = await tratar(ctx, corpo);
    return json(r.corpo, r.status, origem);
  } catch {
    // nada do erro (pode ter CPF, nome ou trecho de laudo) vai para a resposta nem para o log
    return json({ ok: false, erro: "falha", mensagem: "Não foi possível consultar os laudos agora. Tente de novo em instantes." }, 500, origem);
  }
});
