// FLUXOGRAMA: entrada (POST do pg_cron ou à mão com x-sync-key e {"aplicar":true|false,"dias":14}) -> validação (chave = config.ia_segredo; token KLINGO_APP_TOKEN) -> lógica (pede ao banco os pedidos ainda sem agendamento, lê do Klingo as marcações CRIADAS desde a conversa mais antiga (#13825), compara nome completo e exame na memória e manda só o veredito para agendamento_reconhecer_aplicar) -> saída (contagens e ids técnicos; nunca nome, telefone nem valor)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (WC-02 v3)
import { createClient } from "jsr:@supabase/supabase-js@2";
import { casar, type Alvo, type Row } from "./casar.ts";

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const somaDias = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const hojeBrasilia = (): string => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());

// Marcações CRIADAS na faixa (relatório #13825, filtro periodo0 = "Data Agendado Em"); se o Klingo cortar, divide a faixa ao meio e junta.
async function marcacoes(token: string, de: string, ate: string, nivel = 0): Promise<Row[]> {
  const params = new URLSearchParams({ id: "13825", ":periodo0": "l", ":periodo0-from": de, ":periodo0-to": ate });
  const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`Klingo retornou HTTP ${res.status} nas marcações`);
  const payload = await res.json();
  if (payload?.error) throw new Error("Klingo retornou erro nas marcações");
  if (payload?.limit) {
    if (de >= ate || nivel >= 4) throw new Error("O Klingo cortou as marcações mesmo em faixa curta");
    const meio = new Date((Date.parse(`${de}T00:00:00Z`) + Date.parse(`${ate}T00:00:00Z`)) / 2).toISOString().slice(0, 10);
    return [...(await marcacoes(token, de, meio, nivel + 1)), ...(await marcacoes(token, somaDias(meio, 1), ate, nivel + 1))];
  }
  if (payload?.result === "") return [];
  const dados = payload?.result?.data;
  if (!Array.isArray(dados)) throw new Error("Formato inesperado nas marcações");
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
  const aplicar = corpo?.aplicar !== false;
  const dias = Math.max(1, Math.min(Number(corpo?.dias) || 14, 30));
  try {
    const { data: alvosBrutos, error: e1 } = await supabase.rpc("agendamento_reconhecer_alvos", { p_dias: dias });
    if (e1) throw new Error(`O banco recusou a lista de pedidos (${e1.code ?? "sem código"})`);
    const alvos = (Array.isArray(alvosBrutos) ? alvosBrutos : []) as Alvo[];
    if (alvos.length === 0) return json({ ok: true, alvos: 0 });
    const maisAntiga = alvos.reduce((m, a) => (Date.parse(a.conv_criada) < m ? Date.parse(a.conv_criada) : m), Date.now());
    const de = new Date(maisAntiga - 86_400_000).toISOString().slice(0, 10), ate = hojeBrasilia();
    const linhas = await marcacoes(token, de, ate);
    const resultados = alvos.map((a) => casar(a, linhas));
    const util = resultados.filter((r) => r.marcacoes.length > 0 || r.ambiguo);
    const resumo = {
      alvos: alvos.length, linhas_klingo: linhas.length, janela: `${de}..${ate}`,
      com_marcacao: resultados.filter((r) => r.marcacoes.length > 0).length, ambiguos: resultados.filter((r) => r.ambiguo).length,
      identidade_forte: resultados.filter((r) => r.identidade === "forte").length, identidade_media: resultados.filter((r) => r.identidade === "medio").length,
      so_sinal_fraco: resultados.filter((r) => !r.identidade && !r.ambiguo && r.fracos > 0).length, so_outro_exame: resultados.filter((r) => !r.marcacoes.length && !r.ambiguo && r.outros_exames > 0).length,
    };
    if (!aplicar) return json({ ok: true, aplicado: false, ...resumo, detalhes: resultados.filter((r) => r.marcacoes.length > 0).map((r) => ({ id: r.id.slice(0, 8), identidade: r.identidade, marcacoes: r.marcacoes.map((m) => ({ proc: m.proc, para: m.para, em: m.em, unidade: m.unidade, compat: m.compat })) })) });
    const { data: aplicado, error: e2 } = await supabase.rpc("agendamento_reconhecer_aplicar", { p_resultados: util });
    if (e2) throw new Error(`O banco recusou o veredito (${e2.code ?? "sem código"}): ${e2.message.slice(0, 120)}`);
    return json({ ok: true, aplicado: true, ...resumo, resultado: aplicado });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 250) : "erro desconhecido" }, 502);
  }
});
