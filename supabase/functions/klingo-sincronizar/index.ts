// FLUXOGRAMA: entrada (POST {"acao":"catalogo"} com x-klingo-segredo; chamado toda madrugada pelo banco) -> validação (segredo conferido pelo banco)
//   -> lógica (GET /convenios, GET /agenda/especialidades e GET /agenda/consultas por especialidade, tudo pela cota global; só catálogo, nenhum dado de paciente)
//   -> saída (klingo_catalogo_gravar grava convênios/planos/especialidades e traduz sozinho o convênio do chat para o plano do Klingo; resposta só com contagens)
// Versão 1.2 — 12/11/2026 / Mudança: a sondagem passa sexo e nascimento de mentira (o Klingo exige sem a sessão do paciente).
// Versão 1.1 — 12/11/2026 / Mudança: ação "exames": sonda, aos poucos (15 por chamada), se o Klingo tem horário livre para cada exame; o chat usa isso para mostrar ao paciente só o que o Klingo libera.
// Versão 1.0 — 12/11/2026 / Mudança: primeira versão (autoatendimento Klingo, etapa 0: tradução de convênio e especialidade).
// Secret: KLINGO_APP_TOKEN.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cotaGlobal, KlingoApi, KlingoErro } from "./klingo-api.ts";

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
    // Sonda os exames mais pedidos que ainda não foram vistos nos últimos 3 dias: tem horário livre nas próximas 3 semanas? Só catálogo, nenhum dado de paciente.
    const hoje = new Date().toLocaleString("sv-SE", { timeZone: "America/Bahia" }).slice(0, 10);
    const fim = new Date(`${hoje}T12:00:00Z`); fim.setUTCDate(fim.getUTCDate() + 21);
    const { data: ids } = await supabase.rpc("klingo_exames_sondar", { p_n: 15 });
    let tem = 0, vazio = 0, pulados = 0; const tipos: Record<string, number> = {};
    for (const id of (Array.isArray(ids) ? ids : []) as number[]) {
      try {
        // sem a sessão de um paciente o Klingo pede sexo e nascimento: usa um adulto de mentira (nenhum dado real); se não houver horário para o sexo feminino, tenta o masculino
        let achou = false;
        for (const sexo of ["F", "M"]) {
          const hs = await api.horarios({ exame: String(id), inicio: hoje, fim: fim.toISOString().slice(0, 10), sexo, nascimento: "1985-06-15" });
          if (hs.length > 0) { achou = true; break; }
        }
        await supabase.rpc("klingo_sondagem_gravar", { p_proc: id, p_tem: achou });
        if (achou) tem++; else vazio++;
      } catch (e) {
        if (e instanceof KlingoErro && e.tipo === "limite") break;   // o Klingo pediu calma: para por aqui e tenta na próxima rodada
        if (e instanceof KlingoErro && (e.tipo === "sem_medico" || e.tipo === "plano_inativo" || e.tipo === "plano_desconhecido")) { await supabase.rpc("klingo_sondagem_gravar", { p_proc: id, p_tem: false }); vazio++; } else { pulados++; const t = e instanceof KlingoErro ? `${e.tipo}_${e.status}` : "erro"; tipos[t] = (tipos[t] ?? 0) + 1; }
      }
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
