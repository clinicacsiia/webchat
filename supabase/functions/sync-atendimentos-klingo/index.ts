// FLUXOGRAMA: entrada (POST do pg_cron com x-sync-key; corpo opcional {de, ate} para carregar o passado) -> validação (chave = config.ia_segredo; token KLINGO_APP_TOKEN; faixa de datas válida, só passado, até 400 dias) -> lógica (lê o relatório #14637 do Klingo por faixas de 14 dias, mais "hoje" sem filtro; manda em lotes para consulta_atendida_lote) -> saída (só contagens, nunca dado de paciente)
// Versão 1.0 — 16/11/2026 / Mudança: Implementação inicial. Alimenta a regra "primeira consulta com a médica só com atendente" (config primeira_consulta_modo). Não mexe na Jornada.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { acharColunas, dataOk, emLotes, faixas, hojeBrasilia, mapear, somaDias, type Coluna, type Row } from "./mapa.ts";

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const RELATORIO = "14637";
const TAMANHO_LOTE = 400;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Uma faixa do relatório (sem datas = "hoje", o padrão do filtro). Se o Klingo cortar por limite de linhas, divide a faixa ao meio.
async function ler(token: string, de: string | null, ate: string | null, meta: { colunas?: Coluna[] }, nivel = 0): Promise<Row[]> {
  const params = new URLSearchParams({ id: RELATORIO });
  if (de && ate) { params.set(":periodo0", "l"); params.set(":periodo0-from", de); params.set(":periodo0-to", ate); }
  const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`Klingo retornou HTTP ${res.status} nos atendimentos`);
  const payload = await res.json();
  if (payload?.error) throw new Error("Klingo retornou erro nos atendimentos");
  if (payload?.limit) {
    if (!de || !ate || de >= ate || nivel >= 6) throw new Error("O Klingo cortou os atendimentos mesmo em faixa curta");
    const meio = new Date((Date.parse(`${de}T00:00:00Z`) + Date.parse(`${ate}T00:00:00Z`)) / 2).toISOString().slice(0, 10);
    return [...await ler(token, de, meio, meta, nivel + 1), ...await ler(token, somaDias(meio, 1), ate, meta, nivel + 1)];
  }
  if (payload?.result === "") return [];
  const dados = payload?.result?.data;
  if (!Array.isArray(dados)) throw new Error("Formato inesperado nos atendimentos");
  if (!meta.colunas) {
    const cols = [...(Array.isArray(payload?.result?.group_cols) ? payload.result.group_cols : []), ...(Array.isArray(payload?.result?.columns) ? payload.result.columns : [])];
    if (cols.length) meta.colunas = cols as Coluna[];
  }
  return dados as Row[];
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: seg } = await supabase.from("config").select("valor").eq("chave", "ia_segredo").maybeSingle();
  if (!seg?.valor || req.headers.get("x-sync-key") !== seg.valor) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);

  const corpo = await req.json().catch(() => ({}));
  const hoje = hojeBrasilia();
  let de = somaDias(hoje, -2), ate = somaDias(hoje, -1), comHoje = true;   // padrão: anteontem, ontem e hoje
  if (dataOk(corpo?.de) && dataOk(corpo?.ate)) {
    if (corpo.de > corpo.ate || corpo.ate >= hoje || corpo.de < somaDias(hoje, -400)) return json({ error: "Faixa inválida (só datas passadas, até 400 dias)" }, 400);
    de = corpo.de; ate = corpo.ate; comHoje = false;
  }
  const inicio = Date.now();
  try {
    const meta: { colunas?: Coluna[] } = {};
    let lidas = 0, validas = 0, descartadas = 0, gravadas = 0, colunasPor = "";
    const processar = async (linhas: Row[]) => {
      if (!linhas.length) return;
      const { cols, faltando } = acharColunas(meta.colunas ?? []);
      if (faltando.length) throw new Error(`Coluna(s) sumiram do relatório (título mudou?): ${faltando.join(", ").slice(0, 200)}`);
      colunasPor = Object.keys(cols).join(",");
      const { itens, descartadas: d } = mapear(linhas, cols);
      lidas += linhas.length; validas += itens.length; descartadas += d;
      for (const lote of emLotes(itens, TAMANHO_LOTE)) {
        const { data, error } = await supabase.rpc("consulta_atendida_lote", { p_linhas: lote });
        if (error) throw new Error(`O banco recusou um lote (${error.code ?? "sem código"}): ${error.message.slice(0, 120)}`);
        gravadas += (data as { gravadas?: number })?.gravadas ?? 0;
      }
    };
    const lista: [string | null, string | null][] = faixas(de, ate).map(([a, b]) => [a, b]);
    if (comHoje) lista.push([null, null]);
    for (const [a, b] of lista) await processar(await ler(token, a, b, meta));
    return json({ ok: true, janela: `${de}..${comHoje ? "hoje" : ate}`, faixas: lista.length, linhas_klingo: lidas, validas, descartadas, gravadas, colunas: colunasPor, leitura_ms: Date.now() - inicio });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 250) : "erro desconhecido" }, 502);
  }
});
