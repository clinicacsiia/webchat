// FLUXOGRAMA: entrada (POST com x-klingo-segredo; chamado pelo banco a cada 2 min) -> validação (segredo conferido pelo banco) -> lógica (1 chamada leve GET /unidades na API do Klingo, pela cota global; 429 conta como
//   "no ar" porque a API respondeu) -> saída (klingo_saude_gravar guarda ok, tempo e motivo; a tela inicial do chat lê o resultado em chat_saude). Nenhum dado de paciente.
// Versão 1.0 — 13/11/2026 / Mudança: primeira versão (ponto verde/laranja/vermelho na tela inicial).
// Secret: KLINGO_APP_TOKEN.
import { createClient } from "jsr:@supabase/supabase-js@2";

const BASE = "https://api-externa.klingo.app/api";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await supabase.rpc("klingo_segredo_ok", { p_valor: req.headers.get("x-klingo-segredo") ?? "" });
  if (ok !== true) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) { await supabase.rpc("klingo_saude_gravar", { p_tipo: "api", p_ok: false, p_ms: null, p_detalhe: "sem_token" }); return json({ ok: false, motivo: "sem_token" }); }

  // respeita a cota global: se não houver ficha agora, não conta como queda (mantém o último resultado)
  const { data: ficha } = await supabase.rpc("klingo_cota_pegar", { p_n: 1 });
  if (!((ficha ?? {}) as { ok?: boolean }).ok) return json({ ok: true, pulou: "sem_cota" });

  const t0 = Date.now();
  let estado = false, detalhe = "erro";
  try {
    const res = await fetch(`${BASE}/unidades`, { headers: { "X-APP-TOKEN": token, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    const t = await res.text();
    if (res.status === 429) { estado = true; detalhe = "429"; await supabase.rpc("klingo_cota_429"); }
    else if (res.ok && !/^\s*</.test(t)) { try { estado = Array.isArray(JSON.parse(t)); detalhe = estado ? "ok" : "resposta_inesperada"; } catch { detalhe = "json"; } }
    else detalhe = res.ok ? "html" : String(res.status);
  } catch (e) {
    detalhe = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError" ? "timeout" : "rede";
  }
  const ms = Date.now() - t0;
  await supabase.rpc("klingo_saude_gravar", { p_tipo: "api", p_ok: estado, p_ms: ms, p_detalhe: detalhe });
  return json({ ok: estado, ms, detalhe });
});
