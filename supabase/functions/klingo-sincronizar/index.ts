// FLUXOGRAMA: entrada (POST {"acao":"catalogo"} com x-klingo-segredo; chamado toda madrugada pelo banco) -> validação (segredo conferido pelo banco)
//   -> lógica (GET /convenios, GET /agenda/especialidades e GET /agenda/consultas por especialidade, tudo pela cota global; só catálogo, nenhum dado de paciente)
//   -> saída (klingo_catalogo_gravar grava convênios/planos/especialidades e traduz sozinho o convênio do chat para o plano do Klingo; resposta só com contagens)
// Versão 1.0 — 12/11/2026 / Mudança: primeira versão (autoatendimento Klingo, etapa 0: tradução de convênio e especialidade).
// Secret: KLINGO_APP_TOKEN.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, KlingoApi } from "./klingo-api.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await supabase.rpc("klingo_segredo_ok", { p_valor: req.headers.get("x-klingo-segredo") ?? "" });
  if (ok !== true) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);
  const c = await req.json().catch(() => ({}));
  if (c?.acao !== "catalogo") return json({ error: "acao inválida (use catalogo)" }, 400);
  const rpc = (n: string, a: Record<string, unknown>) => supabase.rpc(n, a);
  const api = new KlingoApi(token, (u, i) => fetch(u, i), { antes: cotaGlobal(rpc, { maxTentativas: 10, maxEsperaMs: 3000 }), aoLimite: async () => { await supabase.rpc("klingo_cota_429"); }, tentativas429: 3 });
  try {
    const convenios = await api.convenios();
    const esps = await api.especialidades();
    const especialidades: Array<Record<string, unknown>> = [];
    for (const e of Array.isArray(esps) ? esps.slice(0, 30) : []) {
      const cbos = String(e.cbos ?? "");
      if (!/^\d+$/.test(cbos)) continue;
      const procs = await api.consultas(cbos);
      especialidades.push({ cbos, nome: e.nome, codigo: e.codigo, procedimentos: (Array.isArray(procs) ? procs : []).map((p) => Number(p.id)).filter((n) => Number.isInteger(n)) });
    }
    const { data, error } = await supabase.rpc("klingo_catalogo_gravar", { p: { convenios: Array.isArray(convenios) ? convenios : [], especialidades } });
    if (error) return json({ ok: false, motivo: "gravar" }, 500);
    return json({ ok: true, ...(data as Record<string, unknown>), convenios: Array.isArray(convenios) ? convenios.length : 0 });
  } catch {
    await supabase.rpc("klingo_medir", { p_tipo: "sincronizar_erro", p_n: 1, p_ms: null });
    return json({ ok: false, motivo: "erro" }, 502);
  }
});
