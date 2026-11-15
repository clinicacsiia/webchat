// FLUXOGRAMA: entrada (POST com x-sync-key = config.ia_segredo e {"id","filtros"?,"formato"?: "colN"}) -> validação (só relatórios 14024..14028, 13825, 14359 e 14554) -> lógica (lê o relatório do Klingo na memória) -> saída (SÓ estrutura: filtros, colunas e contagem de linhas; com "formato", o MOLDE da coluna pedida (dígito vira 9, letra vira A) e a contagem de cada molde; nunca valores de linhas)
// Versão 1.3 — 15/11/2026 / Mudança: opção "formato" (molde de uma coluna, ex.: ver se o Check-In vem como AAAA-MM-DD HH:MM:SS); v1.2 — 13/11/2026: libera o #14554 (conferir marcações do dia vindas do webchat) só estrutura e contagem; #13825 e #14359 liberados em 09/11/2026
import { createClient } from "jsr:@supabase/supabase-js@2";

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const PERMITIDOS = new Set(["14024", "14025", "14026", "14027", "14028", "13825", "14359", "14554"]);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

// Molde de um valor: dígitos viram 9 e letras viram A. Nunca devolve o valor (só a forma), cortado em 40 caracteres.
const molde = (v: unknown): string => String(v ?? "").replace(/\d/g, "9").replace(/[A-Za-zÀ-ÿ]/g, "A").slice(0, 40);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: seg } = await supabase.from("config").select("valor").eq("chave", "ia_segredo").maybeSingle();
  if (!seg?.valor || req.headers.get("x-sync-key") !== seg.valor) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);
  const corpo = await req.json().catch(() => ({}));
  const id = String(corpo?.id ?? "");
  if (!PERMITIDOS.has(id)) return json({ error: "Relatório não liberado" }, 400);
  const formato = /^col\d{1,2}$/.test(String(corpo?.formato ?? "")) ? String(corpo.formato) : null;
  const params = new URLSearchParams({ id });
  for (const [k, v] of Object.entries(corpo?.filtros ?? {})) if (/^:?[A-Za-z0-9_-]{1,40}$/.test(k)) params.set(k, String(v).slice(0, 40));
  try {
    const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(90_000) });
    const p = await res.json().catch(() => null);
    const r = p?.result;
    const colunas = [...(Array.isArray(r?.group_cols) ? r.group_cols : []), ...(Array.isArray(r?.columns) ? r.columns : [])].map((c: Record<string, unknown>) => ({ nome: c?.name, titulo: c?.title }));
    const inputs = Array.isArray(p?.inputs) ? p.inputs.map((i: Record<string, unknown>) => ({ id: i?.id, name: i?.name, type: i?.type, operator: i?.operator, value: i?.value })) : null;
    let formatos: Record<string, number> | null = null;
    if (formato && Array.isArray(r?.data)) {
      const cont = new Map<string, number>();
      for (const linha of r.data as Record<string, unknown>[]) { const m = molde(linha?.[formato]) || "(vazio)"; cont.set(m, (cont.get(m) ?? 0) + 1); }
      formatos = Object.fromEntries([...cont.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));
    }
    return json({
      http: res.status, error: p?.error ?? null, limit: p?.limit ?? null,
      linhas: Array.isArray(r?.data) ? r.data.length : (r === "" ? 0 : null),
      inputs, colunas, ...(formato ? { formato, formatos } : {}),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 200) : "erro" }, 502);
  }
});
