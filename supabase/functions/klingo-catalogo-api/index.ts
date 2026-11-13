// FLUXOGRAMA: entrada (POST {"acao":"catalogo"} com x-klingo-segredo; chamado pelo banco toda madrugada) -> validação (segredo conferido pelo banco) -> lógica (GET de catálogo na API do Klingo, tudo pela cota global:
//   unidades, profissionais (com especialidades e idade máxima), exames) -> saída (klingo_catalogo_cru_gravar guarda a resposta; klingo_catalogo_normalizar monta as tabelas klingo_profissional/unidade_api/exame_api;
//   SÓ catálogo, NENHUM dado de paciente; a resposta só tem contagens).
// Versão 1.1 — 13/11/2026 / Mudança: exames sem corte de 400 (guarda só id, descrição, classes e CBOS), normaliza no fim, sem chamadas por especialidade (o roster já traz as especialidades). Versão 1.0: primeira versão.
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
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);
  const c = await req.json().catch(() => ({}));
  if (c?.acao !== "catalogo") return json({ error: "acao inválida (use catalogo)" }, 400);

  const cota = async () => {
    for (let i = 0; i < 10; i++) {
      const { data } = await supabase.rpc("klingo_cota_pegar", { p_n: 1 });
      const d = (data ?? {}) as { ok?: boolean; espera_ms?: number };
      if (d.ok) return true;
      await new Promise((r) => setTimeout(r, Math.min(Math.max(Number(d.espera_ms ?? 1000), 50), 3000)));
    }
    return false;
  };
  const resumo: Record<string, unknown> = {};
  const buscar = async (chave: string, caminho: string, query: Record<string, string> = {}, compactar?: (x: unknown) => unknown) => {
    try {
      if (!(await cota())) { resumo[chave] = "sem_cota"; return null; }
      const q = new URLSearchParams(query);
      const res = await fetch(`${BASE}${caminho}${q.size ? `?${q}` : ""}`, { headers: { "X-APP-TOKEN": token, Accept: "application/json" }, signal: AbortSignal.timeout(25000) });
      const t = await res.text();
      if (res.status === 429) { await supabase.rpc("klingo_cota_429"); resumo[chave] = 429; return null; }
      let dados: unknown = null;
      try { dados = JSON.parse(t); } catch { dados = null; }
      if (!res.ok || dados === null || /^\s*</.test(t)) { resumo[chave] = res.status; return null; }   // erro: mantém a cópia anterior
      const lista = Array.isArray(dados) ? (compactar ? dados.map(compactar) : dados) : dados;
      await supabase.rpc("klingo_catalogo_cru_gravar", { p_endpoint: chave, p_dados: lista, p_status: res.status });
      resumo[chave] = Array.isArray(dados) ? dados.length : "objeto";
      return dados;
    } catch (e) {
      resumo[chave] = (e as Error)?.name ?? "erro";
      return null;
    }
  };

  await buscar("/unidades", "/unidades");
  await buscar("/profissionais", "/profissionais", {}, (p) => { const o = p as Record<string, unknown>; const { cpf: _c, foto: _f, ...resto } = o; return resto; });   // nunca guarda CPF nem foto
  await buscar("/agenda/exames", "/agenda/exames", {}, (x) => { const o = x as Record<string, unknown>; return { id: o.id, descr: o.descr, classes: o.classes, especialidade: { cbos: (o.especialidade as Record<string, unknown> | null)?.cbos ?? null } }; });
  const { data: norm } = await supabase.rpc("klingo_catalogo_normalizar");
  return json({ ok: true, resumo, normalizado: norm });
});
