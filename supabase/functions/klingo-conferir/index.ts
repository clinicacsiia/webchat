// FLUXOGRAMA: entrada (POST do pg_cron com x-sync-key e {"dias":N} ou {"de","ate"}) -> validação (chave = config.ia_segredo; token KLINGO_APP_TOKEN; janela de no máximo 31 dias) -> lógica (lê o relatório #14554 pela data de marcação, divide a faixa se o Klingo cortar, transforma em marcas e manda em lotes para klingo_conferir_lote; depois klingo_conferir_avisos) -> saída (só contagens; nada de paciente vai para resposta nem log)
// Versão 1.0 — 13/11/2026 / Mudança: Implementação inicial (conferência Klingo x webchat)
import { createClient } from "jsr:@supabase/supabase-js@2";
import { emLotes, hojeBrasilia, janelaLeitura, prepararLinhas, somaDias, type Row } from "./mapa.ts";

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const RELATORIO = "14554";
const TAMANHO_LOTE = 250;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// O relatório numa faixa de datas de MARCAÇÃO (filtro periodo0). Se o Klingo cortar por limite de linhas, divide a faixa ao meio e junta.
async function marcacoes(token: string, de: string, ate: string, nivel = 0): Promise<Row[]> {
  const params = new URLSearchParams({ id: RELATORIO, ":periodo0": "l", ":periodo0-from": de, ":periodo0-to": ate });
  const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`Klingo retornou HTTP ${res.status}`);
  const payload = await res.json();
  if (payload?.error) throw new Error("Klingo retornou erro no relatório");
  if (payload?.limit) {
    if (de >= ate || nivel >= 5) throw new Error("O Klingo cortou o relatório mesmo em faixa curta");
    const meio = new Date((Date.parse(`${de}T00:00:00Z`) + Date.parse(`${ate}T00:00:00Z`)) / 2).toISOString().slice(0, 10);
    return [...await marcacoes(token, de, meio, nivel + 1), ...await marcacoes(token, somaDias(meio, 1), ate, nivel + 1)];
  }
  if (payload?.result === "") return [];
  const dados = payload?.result?.data;
  if (!Array.isArray(dados)) throw new Error("Formato inesperado no relatório");
  return dados as Row[];
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: cfg } = await supabase.from("config").select("chave, valor").in("chave", ["ia_segredo"]);
  const sal = (cfg ?? []).find((c: { chave: string }) => c.chave === "ia_segredo")?.valor as string | undefined;
  if (!sal || req.headers.get("x-sync-key") !== sal) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);

  const corpo = await req.json().catch(() => ({}));
  const hoje = hojeBrasilia();
  const { de, ate } = janelaLeitura(corpo, hoje);
  const inicio = Date.now();
  try {
    let brutas: Row[];
    try { brutas = await marcacoes(token, de, ate); }
    catch (e) {
      // O Klingo às vezes recusa período que termina hoje: tenta até ontem.
      if (ate === hoje && ate > de) brutas = await marcacoes(token, de, somaDias(hoje, -1)); else throw e;
    }
    const { linhas, descartadas } = await prepararLinhas(brutas, sal);
    let lidas = 0;
    for (const lote of emLotes(linhas, TAMANHO_LOTE)) {
      const { data, error } = await supabase.rpc("klingo_conferir_lote", { p_linhas: lote });
      if (error) throw new Error(`O banco recusou um lote (${error.code ?? "sem código"}): ${error.message.slice(0, 120)}`);
      lidas += (data as { lidas?: number })?.lidas ?? 0;
    }
    const { data: av, error: eAv } = await supabase.rpc("klingo_conferir_avisos");
    if (eAv) throw new Error(`O banco recusou os avisos (${eAv.code ?? "sem código"}): ${eAv.message.slice(0, 120)}`);
    return json({ ok: true, janela: `${de}..${ate}`, linhas_klingo: brutas.length, descartadas, lidas, avisos: av, leitura_ms: Date.now() - inicio });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 250) : "erro desconhecido" }, 502);
  }
});
