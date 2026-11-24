// FLUXOGRAMA: entrada (POST {operadora, busca?} vindo do site da clínica) -> validação (origem, formato, limite por IP) -> processamento (convênio da operadora em klingo_plano_map; lista de planos pela função STABLE plano_exato_itens; filtro por texto)
//   -> persistência (NENHUMA) -> saída ({ok, total, itens: [{valor, rotulo}]} com no máximo 40 itens; "valor" é o id do plano no Klingo)
// Versão 1.0 — 24/11/2026 / Mudança: função NOVA, só de leitura, do ambiente de testes (/painel/testedowebchat/): lista e pesquisa os planos reais de cada convênio (ex.: SulAmérica tem 1.368).
//   Não chama o Klingo, não grava no banco, não devolve dado de paciente. O "valor" escolhido volta ao teste-agenda-klingo como "OPERADORA#valor" (mesma regra do chat: plano exato).
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGENS = ["https://clinicacsiia.github.io"];
const LIMITE_POR_MIN = 60, MAX_ITENS = 40, CACHE_S = 600;
const semAcento = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const porIp = new Map<string, number[]>();
const cache = new Map<number, { t: number; itens: Array<{ valor: string; rotulo: string }>; exato: boolean }>();

const cors = (origem: string | null) => ({
  "Access-Control-Allow-Origin": origem && ORIGENS.includes(origem) ? origem : ORIGENS[0], "Vary": "Origin",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS",
});

Deno.serve(async (req: Request) => {
  const origem = req.headers.get("origin");
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors(origem), "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origem) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!origem || !ORIGENS.includes(origem)) return json({ error: "Origem não permitida" }, 403);

  const ip = (req.headers.get("x-forwarded-for") ?? "?").split(",")[0].trim(), agora = Date.now();
  const marcas = (porIp.get(ip) ?? []).filter((t) => t > agora - 60_000);
  if (marcas.length >= LIMITE_POR_MIN) return json({ ok: false, motivo: "muitas_consultas" }, 429);
  marcas.push(agora); porIp.set(ip, marcas);

  const c = await req.json().catch(() => ({}));
  const operadora = String(c?.operadora ?? "").trim().slice(0, 80), busca = semAcento(String(c?.busca ?? "").trim().slice(0, 60));
  if (!operadora || /[\r\n]/.test(operadora)) return json({ error: "Pedido inválido" }, 400);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);   // só leitura
  const { data: m } = await sb.from("klingo_plano_map").select("convenio_id, plano_id, origem, operadora").neq("origem", "nao_atende").eq("operadora", operadora).limit(1);
  const mapa = (m ?? [])[0] as { convenio_id: number | null; plano_id: number | null } | undefined;
  if (!mapa || !mapa.convenio_id) return json({ ok: true, total: 0, exato: false, itens: [] });

  let c0 = cache.get(mapa.convenio_id);
  if (!c0 || agora - c0.t > CACHE_S * 1000) {
    const { data: it, error } = await sb.rpc("plano_exato_itens", { p_convenio: mapa.convenio_id });
    if (error || !Array.isArray(it)) return json({ ok: false, motivo: "indisponivel" });
    c0 = { t: agora, itens: it as Array<{ valor: string; rotulo: string }>, exato: mapa.plano_id === null };
    cache.set(mapa.convenio_id, c0);
  }
  const achados = busca ? c0.itens.filter((x) => semAcento(x.rotulo).includes(busca)) : c0.itens;
  return json({ ok: true, total: achados.length, exato: c0.exato, itens: achados.slice(0, MAX_ITENS) });
});
