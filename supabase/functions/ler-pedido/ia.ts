import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { ESQUEMA, limparLeitura, montarPedido, montarSistema, type ItemCatalogo, type Leitura } from "./leitura.ts";

export type Contexto = { mime: string; base64: string; paciente: string; catalogo: ItemCatalogo[]; aprendido: [string, number][] };
export type Resultado = { leitura: Leitura; modelo: string } | { erro: string; modelo: string };

const TIPOS = new Set(["image/jpeg", "image/png", "image/webp"]);

// Uma chamada só: a foto, o catálogo (em cache) e o formato exigido da resposta. Sem conversa, sem ferramentas.
export async function lerComClaude(client: Anthropic, ctx: Contexto, modelo: string, esforco: "low" | "medium" | "high"): Promise<Resultado> {
  if (!TIPOS.has(ctx.mime)) return { erro: `tipo de imagem não aceito: ${ctx.mime}`, modelo };
  try {
    const resp = await client.beta.messages.create({
      model: modelo,
      max_tokens: 16000,
      // Se o filtro de segurança recusar (raro numa foto de pedido), a API refaz no modelo de reserva recomendado.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: esforco, format: { type: "json_schema", schema: ESQUEMA } },
      system: [{ type: "text", text: montarSistema(ctx.catalogo), cache_control: { type: "ephemeral" } }],
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: ctx.mime as "image/jpeg" | "image/png" | "image/webp", data: ctx.base64 } },
          { type: "text", text: montarPedido(ctx.paciente, ctx.aprendido) },
        ],
      }],
    });
    if (resp.stop_reason === "refusal") return { erro: `recusado (${resp.stop_details?.category ?? "sem categoria"})`, modelo: resp.model };
    if (resp.stop_reason === "max_tokens") return { erro: "resposta cortada (max_tokens)", modelo: resp.model };
    const texto = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let bruta: unknown;
    try { bruta = JSON.parse(texto); } catch { return { erro: "resposta fora do formato", modelo: resp.model }; }
    return { leitura: limparLeitura(bruta, ctx.catalogo), modelo: resp.model };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return { erro: "limite de uso da API (429)", modelo };
    if (e instanceof Anthropic.APIConnectionError) return { erro: "sem conexão com a API", modelo };
    if (e instanceof Anthropic.APIError) return { erro: `API ${e.status ?? ""}: ${e.message}`.slice(0, 300), modelo };
    throw e;
  }
}
