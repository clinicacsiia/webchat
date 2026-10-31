import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { lerComClaude, type Contexto } from "./ia.ts";

// Lê a foto do pedido médico com IA (letra de médico) e devolve os exames como opções para o paciente marcar.
// Chamada pelo chat: POST {conversa, token, anexo}. Quem prova que pode ler é o token da conversa (o mesmo do chat),
// por isso a função é publicada sem exigir JWT (o chat usa a chave publicável, que não é JWT).
// A foto já está guardada (chat_anexo_enviar); a leitura também fica guardada e a mesma foto nunca é lida duas vezes.
// Secrets: ANTHROPIC_API_KEY (sem ele a função responde {ok:false, motivo:"sem_chave"} e o chat segue com a leitura do celular).
// Opcionais: OCR_MODELO (padrão claude-opus-5-5) e OCR_ESFORCO (low | medium | high; padrão medium).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const corpo = await req.json().catch(() => ({}));
  const conversa = String(corpo?.conversa ?? ""), token = String(corpo?.token ?? ""), anexo = Number(corpo?.anexo);
  if (!UUID.test(conversa) || !token || token.length > 200 || !Number.isSafeInteger(anexo) || anexo <= 0) return json({ error: "Pedido inválido" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: ctx, error } = await supabase.rpc("ocr_ia_contexto", { p_conversa: conversa, p_token: token, p_anexo: anexo });
  if (error) return json({ error: error.code === "28000" ? "Conversa não encontrada" : "Foto não encontrada" }, 403);
  if (ctx?.pronto) return json({ ok: true, ...ctx.pronto });

  const chave = Deno.env.get("ANTHROPIC_API_KEY");
  if (!chave) return json({ ok: false, motivo: "sem_chave" });
  const modelo = Deno.env.get("OCR_MODELO") || "claude-opus-5-5";
  const esforco = (["low", "medium", "high"].includes(Deno.env.get("OCR_ESFORCO") ?? "") ? Deno.env.get("OCR_ESFORCO") : "medium") as "low" | "medium" | "high";

  const t0 = Date.now();
  const r = await lerComClaude(new Anthropic({ apiKey: chave, timeout: 55_000, maxRetries: 1 }), ctx as Contexto, modelo, esforco);
  const ms = Date.now() - t0;
  if ("erro" in r) {
    await supabase.rpc("ocr_ia_salvar", { p_anexo: anexo, p_leitura: null, p_modelo: r.modelo, p_ms: ms, p_erro: r.erro });
    console.error("ler-pedido:", r.erro);
    return json({ ok: false, motivo: "falha" });
  }
  const { data: grupos, error: e2 } = await supabase.rpc("ocr_ia_salvar", { p_anexo: anexo, p_leitura: r.leitura, p_modelo: r.modelo, p_ms: ms, p_erro: null });
  if (e2) return json({ ok: false, motivo: "falha" });
  return json({ ok: true, ms, ...grupos });
});
