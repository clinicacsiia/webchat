import { createClient } from "jsr:@supabase/supabase-js@2";

// Atualiza o catálogo que a IA consulta (procedimentos, agenda e planos) a partir de relatórios do Klingo.
// Só relatórios de cadastro, sem dado de paciente. O token fica no secret KLINGO_APP_TOKEN.
// Chamada: POST com o header x-sync-key igual a config.ia_segredo (a noite, pelo pg_cron; ou à mão).

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
type Row = Record<string, unknown>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function relatorio(id: string, token: string): Promise<Row[]> {
  const res = await fetch(`${KLINGO_URL}?id=${id}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Klingo retornou HTTP ${res.status} no relatório ${id}`);
  const payload = await res.json();
  if (payload?.error) throw new Error(`Klingo retornou erro no relatório ${id}`);
  if (payload?.limit) throw new Error(`O Klingo cortou o relatório ${id} (limite de linhas)`);
  const data = payload?.result?.data;
  if (!Array.isArray(data) || data.length === 0) throw new Error(`Relatório ${id} veio vazio ou em formato inesperado`);
  return data as Row[];
}

const txt = (v: unknown) => (v === null || v === undefined || v === "" || v === 0 ? null : String(v).trim() || null);
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: seg } = await supabase.from("config").select("valor").eq("chave", "ia_segredo").maybeSingle();
  if (!seg?.valor || req.headers.get("x-sync-key") !== seg.valor) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);

  const resultado: Record<string, unknown> = {};
  const erros: string[] = [];
  const etapas: Array<[string, string, (d: Row[]) => unknown[]]> = [
    ["procedimento", "13981", (d) => d.map((r) => ({
      id: num(r.col0), nome: txt(r.col1), tuss: txt(r.col2), especialidade: txt(r.col5), classe: txt(r.col6),
      idade_min: num(r.col8), idade_max: num(r.col9), sexo: txt(r.col10), preparo: txt(r.col13),
    })).filter((r) => r.id !== null && r.nome)],
    ["plano", "12301", (d) => d.map((r) => ({ operadora: txt(r.col0), plano: txt(r.col1), produto: txt(r.col2) })).filter((r) => r.operadora || r.plano)],
    ["agenda", "13984", (d) => d.map((r) => ({
      unidade: txt(r.col3), local: txt(r.col4), profissional_id: num(r.col5), profissional: txt(r.col6), especialidade: txt(r.col8),
      procedimento_id: num(r.col9), procedimento: txt(r.col10), dia_num: num(r.col11), dia: txt(r.col12),
      hora_ini: txt(r.col13), hora_fim: txt(r.col14), duracao_min: num(r.col15), operadoras: txt(r.col16),
      tele: r.col17 === "S", vagas_extras: num(r.col18), vig_ini: txt(r.col19), vig_fim: txt(r.col20),
    })).filter((r) => r.profissional && r.dia && r.hora_ini && r.hora_fim && r.vig_ini && r.vig_fim)],
  ];

  // Cada relatório é independente: se um falhar, o catálogo anterior dele continua valendo.
  for (const [tipo, id, mapear] of etapas) {
    try {
      const linhas = mapear(await relatorio(id, token));
      const { data, error } = await supabase.rpc("catalogo_substituir", { p_tipo: tipo, p_linhas: linhas });
      if (error) throw new Error(error.message);
      resultado[tipo] = data;
    } catch (e) {
      erros.push(`${tipo}: ${e instanceof Error ? e.message : "erro desconhecido"}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return json({ atualizados: resultado, erros }, erros.length ? 207 : 200);
});
