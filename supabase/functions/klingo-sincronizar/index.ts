// FLUXOGRAMA: entrada (POST {"acao":"catalogo"} ou {"acao":"exames"} com x-klingo-segredo; chamado toda madrugada pelo banco) -> validação (segredo conferido pelo banco)
//   -> lógica (GET /convenios, GET /agenda/especialidades e GET /agenda/consultas por especialidade, tudo pela cota global; só catálogo, nenhum dado de paciente)
//   -> saída (klingo_catalogo_gravar grava convênios/planos/especialidades e traduz sozinho o convênio do chat para o plano do Klingo; resposta só com contagens)
// Versão 1.0 — 12/11/2026 / Mudança: primeira versão (autoatendimento Klingo, etapa 0: tradução de convênio e especialidade).
// Versão 1.4 — 15/11/2026 / Mudança: "exames" olha 45 dias (3 janelas de 15), 25 exames por rodada com pausa entre eles (deixa cota para as pacientes) e grava o primeiro dia com horário (sondagem.ts). O repositório estava atrasado: a ação "exames" (v1.1 a 1.3) só existia no ar.
// Versão 1.3 — 12/11/2026 / Mudança: janela de 14 dias (o Klingo recusa mais de 15). Versão 1.2: a sondagem passa sexo e nascimento de mentira.
// Versão 1.1 — 12/11/2026 / Mudança: ação "exames": sonda, aos poucos, se o Klingo tem horário livre para cada exame; o chat usa isso para mostrar ao paciente só o que o Klingo libera.
// Secret: KLINGO_APP_TOKEN.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, KlingoApi } from "./klingo-api.ts";
import { sondarExame } from "./sondagem.ts";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ok } = await supabase.rpc("klingo_segredo_ok", { p_valor: req.headers.get("x-klingo-segredo") ?? "" });
  if (ok !== true) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);
  const c = await req.json().catch(() => ({}));
  if (c?.acao !== "catalogo" && c?.acao !== "exames") return json({ error: "acao inválida (use catalogo ou exames)" }, 400);
  const rpc = (n: string, a: Record<string, unknown>) => supabase.rpc(n, a);
  const api = new KlingoApi(token, (u, i) => fetch(u, i), { antes: cotaGlobal(rpc, { maxTentativas: 10, maxEsperaMs: 3000 }), aoLimite: async () => { await supabase.rpc("klingo_cota_429"); }, tentativas429: 3 });
  if (c.acao === "exames") {
    // Varredura: para cada exame do chat que a API do Klingo lista, tem horário livre nos próximos 45 dias? O chat só mostra o que o Klingo confirma. Só catálogo, nenhum dado de paciente.
    const hoje = new Date().toLocaleString("sv-SE", { timeZone: "America/Bahia" }).slice(0, 10);
    const { data: ids } = await supabase.rpc("klingo_exames_sondar", { p_n: 25 });
    let tem = 0, vazio = 0, pulados = 0; const tipos: Record<string, number> = {};
    for (const id of (Array.isArray(ids) ? ids : []) as number[]) {
      const r = await sondarExame(api, id, hoje);
      if (r.tipo === "limite") break;   // o Klingo pediu calma: para por aqui e tenta na próxima rodada
      if (r.tipo === "pular") { pulados++; tipos[r.motivo] = (tipos[r.motivo] ?? 0) + 1; }
      else { await supabase.rpc("klingo_sondagem_registrar", { p_proc: id, p_tem: r.tipo === "tem", p_primeiro: r.tipo === "tem" ? r.primeiro : null }); if (r.tipo === "tem") tem++; else vazio++; }
      await new Promise((ok) => setTimeout(ok, 1500));   // deixa fichas da cota para quem está no chat agora
    }
    return json({ ok: true, com_horario: tem, sem_horario: vazio, pulados, tipos });
  }
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
