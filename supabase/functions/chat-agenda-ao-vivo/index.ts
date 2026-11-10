import { createClient } from "jsr:@supabase/supabase-js@2";
import { agruparMarcacoes, blocosConsecutivos, diasEntre, maisAntigo, type Row } from "./agrupar.ts";

// FLUXOGRAMA: entrada (o chat avisa que a paciente chegou ao passo de dia/horário/médico: POST {conversa, token, de, ate}) -> validação (token da conversa, interruptor, período de até 15 dias, limite de pedidos) -> lógica (para cada dia: reaproveita leitura de segundos atrás, espera quem já está lendo ou lê o relatório #7 do Klingo em blocos paralelos; troca a ocupação do período e libera o cancelado) -> saída ({ok, lido_em, falhas}; o chat então pede os horários ao banco, que já enxerga a agenda de agora)
// Versão 1.0 — 10/11/2026 / Mudança: Implementação inicial (AGE-04: dia, horário e médico mostrados à paciente são lidos ao vivo no Klingo)
//
// Quem prova que pode pedir é o token da conversa (o mesmo do chat), por isso a função é publicada SEM exigir JWT (o chat usa a chave publicável,
// que não é JWT), igual à ler-pedido. Para diagnóstico há também o header x-sync-key (= config.ia_segredo), que dispensa o token.
// Sem dado de paciente: as linhas do relatório #7 ficam só na memória; sai apenas quando, quem atende, onde e qual exame.
// Secret: KLINGO_APP_TOKEN. Chaves em config: agenda_ao_vivo, agenda_ao_vivo_validade_s, agenda_ao_vivo_trava_s, agenda_ao_vivo_max_dias (ver supabase/agenda-ao-vivo.sql).

const KLINGO_URL = "https://api-externa.klingo.app/api/info/relatorio";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, x-sync-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const dorme = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Relatório #7 (marcações) de uma faixa de dias; se o Klingo cortar por limite de linhas, divide a faixa ao meio.
async function lerKlingo(token: string, de: string, ate: string, nivel = 0): Promise<Row[]> {
  const params = new URLSearchParams({ id: "7", ":data_atendimento": "l", ":data_atendimento-from": de, ":data_atendimento-to": ate });
  const res = await fetch(`${KLINGO_URL}?${params}`, { headers: { "X-APP-TOKEN": token }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Klingo retornou HTTP ${res.status}`);
  const payload = await res.json();
  if (payload?.error) throw new Error("Klingo retornou erro na agenda marcada");
  if (payload?.limit) {
    if (de >= ate || nivel >= 3) throw new Error("O Klingo cortou a agenda marcada mesmo em faixa curta");
    const dias = diasEntre(de, ate), i = Math.floor((dias.length - 1) / 2);
    const [a, b] = await Promise.all([lerKlingo(token, de, dias[i], nivel + 1), lerKlingo(token, dias[i + 1], ate, nivel + 1)]);
    return [...a, ...b];
  }
  if (payload?.result === "") return [];
  const dados = payload?.result?.data;
  if (!Array.isArray(dados)) throw new Error("Formato inesperado na agenda marcada");
  return dados as Row[];
}

type Acao = { dia_ref: string; acao: "fresco" | "lendo" | "ler" | "ocupado"; lido: string | null; iniciado: string | null };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const t0 = Date.now();
  const corpo = await req.json().catch(() => ({}));
  const de = String(corpo?.de ?? ""), ate = String(corpo?.ate ?? "");
  let dias: string[];
  try { dias = diasEntre(de, ate); } catch { return json({ error: "Pedido inválido" }, 400); }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const chave = req.headers.get("x-sync-key");
  if (chave) {
    // Modo diagnóstico (TI): dispensa o token da conversa, mas exige o segredo do projeto.
    const { data: seg } = await supabase.from("config").select("valor").eq("chave", "ia_segredo").maybeSingle();
    if (!seg?.valor || chave !== seg.valor) return json({ error: "Forbidden" }, 403);
  } else {
    const conversa = String(corpo?.conversa ?? ""), tokenConversa = String(corpo?.token ?? "");
    if (!UUID.test(conversa) || !tokenConversa || tokenConversa.length > 200 || !DATA.test(de) || !DATA.test(ate)) return json({ error: "Pedido inválido" }, 400);
    const { data: v, error } = await supabase.rpc("chat_ao_vivo_validar", { p_conversa: conversa, p_token: tokenConversa, p_de: de, p_ate: ate });
    if (error) return json({ error: error.code === "28000" ? "Conversa não encontrada" : "Período inválido" }, error.code === "28000" ? 403 : 400);
    if (!v?.ok) return json({ ok: false, motivo: v?.motivo ?? "indisponivel" });
  }
  const tokenKlingo = Deno.env.get("KLINGO_APP_TOKEN");
  if (!tokenKlingo) return json({ ok: false, motivo: "sem_chave" });

  const limite = t0 + 28_000;
  const lidoEm = new Map<string, string>();
  const lidos = new Set<string>(), reaproveitados = new Set<string>(), falhas = new Set<string>();
  let pend = dias;
  for (let rodada = 0; pend.length && Date.now() < limite && rodada < 14; rodada++) {
    const { data, error } = await supabase.rpc("agenda_ao_vivo_pedir", { p_dias: pend });
    if (error) { console.error("chat-agenda-ao-vivo pedir:", String(error.message).slice(0, 200)); break; }
    const acoes = (data ?? []) as Acao[];
    for (const a of acoes) if (a.acao === "fresco" && a.lido) { lidoEm.set(a.dia_ref, a.lido); reaproveitados.add(a.dia_ref); }
    const ler = acoes.filter((a) => a.acao === "ler" && a.iniciado);
    if (ler.length) {
      const iniciadoDe = new Map(ler.map((a) => [a.dia_ref, a.iniciado as string]));
      await Promise.all(blocosConsecutivos(ler.map((a) => a.dia_ref)).map(async (b) => {
        const iniciado = iniciadoDe.get(b.dias[0]) as string;
        try {
          const linhas = agruparMarcacoes(await lerKlingo(tokenKlingo, b.de, b.ate));
          const { error: eg } = await supabase.rpc("agenda_ao_vivo_gravar", { p_de: b.de, p_ate: b.ate, p_dias: b.dias, p_iniciado: iniciado, p_linhas: linhas, p_ok: true, p_erro: null });
          if (eg) throw new Error(eg.message);
          for (const d of b.dias) { lidoEm.set(d, iniciado); lidos.add(d); }
        } catch (e) {
          const msg = e instanceof Error ? e.message : "falha";
          console.error("chat-agenda-ao-vivo ler:", msg.slice(0, 200));
          await supabase.rpc("agenda_ao_vivo_gravar", { p_de: b.de, p_ate: b.ate, p_dias: b.dias, p_iniciado: iniciado, p_linhas: [], p_ok: false, p_erro: msg });
          for (const d of b.dias) falhas.add(d);
        }
      }));
    }
    // Quem outra chamada está lendo (ou o teto global): espera um pouco e pergunta de novo.
    pend = acoes.filter((a) => a.acao === "lendo" || a.acao === "ocupado").map((a) => a.dia_ref);
    if (pend.length) await dorme(800);
  }
  for (const d of pend) falhas.add(d);
  const conferidos = dias.filter((d) => !falhas.has(d));
  return json({
    ok: falhas.size === 0,
    lido_em: maisAntigo(conferidos.map((d) => lidoEm.get(d))),
    lidos: lidos.size, reaproveitados: reaproveitados.size, falhas: [...falhas].sort(), ms: Date.now() - t0,
  });
});
