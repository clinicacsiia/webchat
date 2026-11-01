// FLUXOGRAMA: entrada (POST do pg_cron com x-sync-key e {"modo":"rapido"|"completo"}) -> validação (chave = config.ia_segredo; token KLINGO_APP_TOKEN; relatório e filtro vindos da config) -> lógica (lê o relatório do Klingo na janela do modo, mapeia, manda em lotes para jornada_klingo_lote e fecha com jornada_klingo_fechar) -> saída (resumo SEM dado de paciente; em erro, jornada_klingo_falha)
// Versão 1.0 — 01/11/2026 / Mudança: Implementação inicial
import { createClient } from "jsr:@supabase/supabase-js@2";
import { emLotes, filtroValido, hojeBrasilia, janelaLeitura, modoValido, prepararLinhas, relatorioValido, somaDias, CARTOES_ATRAS, CARTOES_FRENTE, type Row } from "./mapa.ts";

// Lê as marcações do Klingo e alimenta o quadro "Jornada" do painel. Quem chama é o pg_cron (todo minuto, mas o banco só dispara quando é a hora: jornada_klingo_agendar).
// As linhas do relatório têm nome e telefone de pacientes: ficam só na memória desta função; o telefone vira uma marca (hash) e o valor em R$ nunca é lido.
// Nada de paciente vai para o log nem para a resposta: só contagens.

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const TAMANHO_LOTE = 400;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// O relatório em uma faixa de datas; se o Klingo cortar (limite de linhas), divide a faixa ao meio e junta.
async function marcacoes(token: string, id: string, de: string, ate: string, nivel = 0): Promise<Row[]> {
  const params = new URLSearchParams({ id, ":periodo0": "l", ":periodo0-from": de, ":periodo0-to": ate });
  const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`Klingo retornou HTTP ${res.status} nas marcações`);
  const payload = await res.json();
  if (payload?.error) throw new Error("Klingo retornou erro nas marcações");
  if (payload?.limit) {
    if (de >= ate || nivel >= 4) throw new Error("O Klingo cortou as marcações mesmo em faixa curta");
    const meio = new Date((Date.parse(`${de}T00:00:00Z`) + Date.parse(`${ate}T00:00:00Z`)) / 2).toISOString().slice(0, 10);
    const a = await marcacoes(token, id, de, meio, nivel + 1);
    const b = await marcacoes(token, id, somaDias(meio, 1), ate, nivel + 1);
    return [...a, ...b];
  }
  if (payload?.result === "") return [];
  const dados = payload?.result?.data;
  if (!Array.isArray(dados)) throw new Error("Formato inesperado nas marcações");
  return dados as Row[];
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: cfg } = await supabase.from("config").select("chave, valor").in("chave", ["ia_segredo", "jornada_relatorio_id", "jornada_relatorio_filtro"]);
  const config = Object.fromEntries((cfg ?? []).map((c: { chave: string; valor: string }) => [c.chave, c.valor]));
  if (!config.ia_segredo || req.headers.get("x-sync-key") !== config.ia_segredo) return json({ error: "Forbidden" }, 403);
  const token = Deno.env.get("KLINGO_APP_TOKEN");
  if (!token) {
    await supabase.rpc("jornada_klingo_falha", { p_erro: "KLINGO_APP_TOKEN não configurado" });
    return json({ error: "KLINGO_APP_TOKEN não configurado" }, 500);
  }

  const corpo = await req.json().catch(() => ({}));
  const modo = modoValido(corpo?.modo);
  const filtro = filtroValido(config.jornada_relatorio_filtro);
  const relatorio = relatorioValido(config.jornada_relatorio_id);
  const hoje = hojeBrasilia();
  const { de, ate } = janelaLeitura(modo, filtro, hoje);
  const inicio = Date.now();

  try {
    const brutas = await marcacoes(token, relatorio, de, ate);
    // Uma leitura completa que volta vazia é quase sempre o Klingo fora do ar ou o relatório mudado: não finge que deu certo.
    if (modo === "completo" && brutas.length === 0) throw new Error("O relatório veio vazio na leitura completa");
    const { linhas, descartadas, descartes, fora, semProntuario } = await prepararLinhas(brutas, config.ia_segredo, hoje);

    let lidas = 0, alteradas = 0, cartoesCriados = 0;
    for (const lote of emLotes(linhas, TAMANHO_LOTE)) {
      const { data, error } = await supabase.rpc("jornada_klingo_lote", { p_linhas: lote });
      if (error) throw new Error(`O banco recusou um lote (${error.code ?? "sem código"}): ${error.message.slice(0, 120)}`);
      const r = data as { lidas?: number; alteradas?: number; cartoes_criados?: number };
      lidas += r?.lidas ?? 0; alteradas += r?.alteradas ?? 0; cartoesCriados += r?.cartoes_criados ?? 0;
    }

    const resumo = { modo, relatorio, filtro, janela: `${de}..${ate}`, linhas_klingo: brutas.length, descartadas, descartes, chave_por_nome: semProntuario, fora_da_janela: fora, lidas, alteradas, cartoes_criados: cartoesCriados, leitura_ms: Date.now() - inicio };
    const { data: fechado, error: e2 } = await supabase.rpc("jornada_klingo_fechar", { p_atras: CARTOES_ATRAS, p_frente: CARTOES_FRENTE, p_resumo: resumo });
    if (e2) throw new Error(`O banco recusou o fechamento (${e2.code ?? "sem código"}): ${e2.message.slice(0, 120)}`);
    return json({ ok: true, ...(fechado as Record<string, unknown>) });
  } catch (e) {
    const mensagem = e instanceof Error ? e.message.slice(0, 250) : "erro desconhecido";
    await supabase.rpc("jornada_klingo_falha", { p_erro: mensagem });
    return json({ error: mensagem }, 502);
  }
});
